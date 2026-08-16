import { z } from 'zod';
import {
  MAX_ADMIN_INFO_LENGTH,
  MAX_ANSWERS,
  MAX_ANSWERS_BYTES,
  MAX_ANSWER_KEY_LENGTH,
} from '../../config/constants.ts';
import { REFERRAL_STATUSES } from '../../db/schema/referrals.ts';
import { isPlainDate } from '../../core/time/plain-date.ts';

/**
 * Required-ness for personal data lives **here**, not in the DDL.
 *
 * The database columns are nullable so a purge can null them in place —
 * SQLite has no `ALTER COLUMN`, so a `NOT NULL` personal-data column could
 * never be purged. This schema is the only route by which a referral is
 * created, so it is where "a referee must have a surname" is enforced.
 */

const personName = z.string().trim().min(1).max(100);
const fullName = z.string().trim().min(1).max(200);
const organisation = z.string().trim().min(1).max(200);
const address = z.string().trim().min(1).max(500);
const postcode = z.string().trim().min(2).max(12);
const phone = z.string().trim().min(5).max(30);
const dateOfBirth = z.string().refine(isPlainDate, 'must be a real YYYY-MM-DD date');

/**
 * The dynamic answers, stored exactly as sent.
 *
 * The referral form is client configuration, so the server holds no definition
 * to validate against and does not try to — it takes what it is given. The
 * only checks here are on **size**, because this arrives on an unauthenticated
 * write and an unbounded blob is a storage vector rather than a referral.
 * These are limits on the request, not rules about the form.
 */
const answers = z
  .record(z.string().max(MAX_ANSWER_KEY_LENGTH), z.unknown())
  .refine((value) => Object.keys(value).length <= MAX_ANSWERS, 'too many answers')
  .refine(
    (value) => JSON.stringify(value).length <= MAX_ANSWERS_BYTES,
    'the answers are too large to store',
  );

export const referralSubmissionSchema = z.object({
  sessionId: z.uuid(),
  reasonId: z.uuid(),

  referrerName: fullName,
  referrerEmail: z.email().max(254),
  /**
   * Supplied rather than derived.
   *
   * An unrecognised referrer has no authorised-referrer row to derive an
   * organisation from, which is why the form asks — the dropdown for one on the
   * list, the free-text box for one that is not. The server still writes
   * `authorisedReferrerId` from its own match, so this string never decides
   * which organisation a referral is credited to.
   */
  referrerOrganisation: organisation,
  referrerPhone: phone.optional(),

  refereeFirstName: personName,
  refereeSurname: personName,
  /** A date, not an age: an age is wrong a year after it is recorded. */
  refereeDateOfBirth: dateOfBirth,
  refereeAddress: address,
  refereePostcode: postcode,
  refereePhone: phone.optional(),

  /**
   * The household as two counts, and the server has no opinion about how the
   * client arrived at them. Whatever the form asks — age bands or anything
   * else — is the client's form definition to hold and the client's rules to
   * apply; what reaches here is the operational pair everything downstream
   * speaks: the 5x6 grid, the parcel snapshot, `familySize`.
   *
   * At least one adult: the household grid starts at one adult, so a
   * childless-of-adults referral would have no model parcel to map to.
   */
  adults: z.number().int().min(1).max(30),
  children: z.number().int().min(0).max(30),

  /** A delivery goes to `refereeAddress`; there is no second address. */
  isDelivery: z.boolean().default(false),

  /**
   * A column rather than an answer because the charity reports on it. The two
   * questions that follow from it stay in `answers`.
   */
  needsFuelHelp: z.boolean().default(false),

  answers: answers.default({}),
});

export type ReferralSubmission = z.infer<typeof referralSubmissionSchema>;

/**
 * What an administrator may change after the fact: **the household's own
 * details, the answers, and the administrators' own note.**
 *
 * There is no self-service equivalent: a referrer confirms what they sent and
 * phones the food bank if it needs changing, and an administrator makes the
 * correction. A referrer who spelled an address wrong, or a household that has
 * moved between being referred and being fed, has to be correctable — a parcel
 * delivered to the address on the form is delivered to whatever the form says.
 *
 * **The referrer's own details are not here.** `referrerEmail` above all: it is
 * what the authorisation decision was made on, so editing it would leave a
 * referral whose accepted-or-held status no longer follows from its address.
 * The name, phone and organisation stay with it, because who sent a referral is
 * a matter of record rather than a field to tidy.
 *
 * Every field is optional and only what is sent is written, so a client can
 * send one corrected field without restating the rest. **`answers` is the
 * exception**: it replaces the stored set outright rather than merging, because
 * the client holds the form and a key it omits has been removed. Which answer
 * counts as "other information" is the client's to know — the server holds no
 * form definition and does not police which key moved.
 */
export const referralAmendSchema = z.object({
  refereeFirstName: personName.optional(),
  refereeSurname: personName.optional(),
  refereeDateOfBirth: dateOfBirth.optional(),
  refereeAddress: address.optional(),
  refereePostcode: postcode.optional(),
  /** Nullable: a household may lose a number as well as gain one. */
  refereePhone: phone.nullable().optional(),
  adults: z.number().int().min(1).max(30).optional(),
  children: z.number().int().min(0).max(30).optional(),
  isDelivery: z.boolean().optional(),
  needsFuelHelp: z.boolean().optional(),
  reasonId: z.uuid().optional(),
  /** Replaces the stored set outright; it is not merged into it. */
  answers: answers.optional(),
  /**
   * The administrators' own note about the household.
   *
   * Nullable for the same reason `refereePhone` is: `null` is a real value
   * meaning "there is no note now", and omitting the key leaves whatever is
   * there alone. **An empty string is a `400`, not a clearance** — the repo
   * refuses empty text everywhere (`cancelReferralSchema`,
   * `rejectReferralSchema`), and quietly turning `''` into `null` would make
   * one of the two ways of clearing a note invisible in the contract.
   *
   * Not part of `answers`. The answers are what the referrer submitted and the
   * client replaces them wholesale from the form it owns; this is what the
   * office wrote, and the server holds it as its own field so that a form the
   * client reshapes cannot take it with it.
   */
  adminInfo: z.string().trim().min(1).max(MAX_ADMIN_INFO_LENGTH).nullable().optional(),
});

export type ReferralAmend = z.infer<typeof referralAmendSchema>;

/**
 * The whole `PATCH` body: an amendment, a move, or both.
 *
 * Moving may exceed capacity, but only when explicitly acknowledged — the spec
 * calls for a warning the operator has to accept, and this is the server half
 * of that.
 *
 * **Strict, and that is the point.** Zod strips unknown keys by default, which
 * would turn a client sending a field this does not accept — `referrerEmail`,
 * say — into a `200` that silently changed nothing. An administrator would
 * watch a correction they typed disappear and have no way to tell. A client
 * sending one gets a `400` naming it instead.
 */
export const referralAdminAmendSchema = z
  .strictObject({
    ...referralAmendSchema.shape,
    sessionId: z.uuid().optional(),
    acknowledgeOverCapacity: z.boolean().default(false),
  })
  .refine(
    (value) =>
      value.sessionId !== undefined ||
      Object.keys(referralAmendSchema.shape).some(
        (field) => value[field as keyof typeof value] !== undefined,
      ),
    'supply something to change, a session, or both',
  );

export const cancelReferralSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

/**
 * `POST /referrals/{id}/copy` — the session the copy goes onto, and the same
 * over-capacity acknowledgement a move takes, because choosing a session works
 * the same way for both. `INITIAL_SPEC1.txt`, `#Copying a referral`.
 *
 * **Nothing about the household, deliberately.** Every other field on the copy
 * comes from the original or is the server's own. A body that could carry a
 * name here would be a way of creating a referral for anybody through an
 * admin-only route that skips the review the public one goes through — and the
 * point of a copy is that it is the same household, not a new one. An
 * administrator who needs to change something corrects the copy afterwards,
 * which is what `PATCH /referrals/{id}` is for.
 */
export const copyReferralSchema = z.strictObject({
  sessionId: z.uuid(),
  acknowledgeOverCapacity: z.boolean().default(false),
});

/**
 * The administrator's note on why a referral was let through or turned away.
 *
 * One short line. It is overwritten by a later decision — there is no history —
 * and it is admin-only on the way out, because it can name a referrer or
 * explain a suspicion.
 *
 * `authoriseReferrer` is the second accept button: accept this referral and add
 * its referrer to the authorised list at the same time. The organisation name
 * is required and typed by the administrator rather than taken from what the
 * referrer put on the form — the authorised list is the key organisations are
 * reported on, and free text fills it with three spellings of one council.
 * Only ever the referrer's own address; there is no domain option here on
 * purpose.
 */
export const rejectReferralSchema = z.object({
  comment: z.string().trim().min(1).max(200).optional(),
});

export const acceptReferralSchema = rejectReferralSchema.safeExtend({
  authoriseReferrer: z.object({ organisationName: organisation }).optional(),
});

export const referralListQuerySchema = z.object({
  sessionId: z.uuid().optional(),
  status: z.enum(REFERRAL_STATUSES).optional(),
});

/**
 * `GET /referrals/{id}/repeat-referrals`'s one query parameter.
 *
 * **Not `z.coerce.boolean()`.** Coercion turns any non-empty string —
 * including the string `"false"` — into `true`, which would make
 * `?excludePostcode=false` do the opposite of what it says. Parsed as one of
 * two literal strings instead, so anything else is a validation error rather
 * than a silent `true`.
 */
export const repeatReferralsQuerySchema = z.object({
  excludePostcode: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

/**
 * `POST /referrals/search` — an administrator looking a household up when
 * somebody rings in. `INITIAL_SPEC1.txt`, `#Searching for a referral`: any
 * one of the three, or more than one, and at least one is required — a
 * search matching on nothing would return every referral the food bank has
 * ever held.
 *
 * The three primitives are the same `postcode`, `phone` and `dateOfBirth`
 * used on submission and amendment: there is no second definition of what a
 * postcode or a phone number looks like. A value that does not look like one
 * of those is a `400` here, same as on submission — this is a shape check,
 * not the settling into matching form, which happens once in the service via
 * `normalisePostcode` / `normalisePhone` and never here.
 *
 * **`surnamePrefix` is a filter, not a fourth identifier.** It narrows what
 * the three found and cannot be searched on alone, so the refusal below counts
 * only the three — a body carrying nothing but a surname is a `400`. The spec
 * is explicit about why: a surname on its own would return every household of
 * that name the food bank has ever fed, which is the thing this endpoint
 * exists not to do.
 */
export const referralSearchSchema = z
  .object({
    postcode: postcode.optional(),
    phone: phone.optional(),
    dateOfBirth: dateOfBirth.optional(),
    surnamePrefix: personName.optional(),
  })
  .refine(
    (value) =>
      value.postcode !== undefined || value.phone !== undefined || value.dateOfBirth !== undefined,
    'supply a postcode, a phone number or a date of birth',
  );

export type ReferralSearch = z.infer<typeof referralSearchSchema>;
