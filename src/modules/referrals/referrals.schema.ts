import { z } from 'zod';
import { MAX_ANSWERS, MAX_ANSWERS_BYTES, MAX_ANSWER_KEY_LENGTH } from '../../config/constants.ts';
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

export const referralSubmissionSchema = z
  .object({
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
     * The household as four age bands, not the two operational counts they
     * derive into — see `deriveHousehold` in `age-bands.ts`. All four are
     * required: there is no band a form can leave unanswered, only one that is
     * zero.
     */
    infants: z.number().int().min(0).max(30),
    children4To11: z.number().int().min(0).max(30),
    teenagers12To17: z.number().int().min(0).max(30),
    adults18Plus: z.number().int().min(0).max(30),

    /** A delivery goes to `refereeAddress`; there is no second address. */
    isDelivery: z.boolean().default(false),

    /**
     * A column rather than an answer because the charity reports on it. The two
     * questions that follow from it stay in `answers`.
     */
    needsFuelHelp: z.boolean().default(false),

    answers: answers.default({}),
  })
  .refine(
    (value) => value.teenagers12To17 + value.adults18Plus >= 1,
    'a household must include at least one person aged 12 or over',
  );

export type ReferralSubmission = z.infer<typeof referralSubmissionSchema>;

/**
 * What an administrator may change after the fact: **the household's own
 * details, and the answers.**
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
  /**
   * The same four bands as submission, all optional: an amendment is a
   * partial patch and only what is sent is written. "At least one adult" is
   * now a rule about age — at least one person aged 12 or over — and cannot
   * be checked here: a patch that only lowers `adults18Plus` cannot see the
   * stored `teenagers12To17` it would leave the household with. The service
   * checks the *merged* result before writing; see `applyAmendment`.
   */
  infants: z.number().int().min(0).max(30).optional(),
  children4To11: z.number().int().min(0).max(30).optional(),
  teenagers12To17: z.number().int().min(0).max(30).optional(),
  adults18Plus: z.number().int().min(0).max(30).optional(),
  isDelivery: z.boolean().optional(),
  needsFuelHelp: z.boolean().optional(),
  reasonId: z.uuid().optional(),
  /** Replaces the stored set outright; it is not merged into it. */
  answers: answers.optional(),
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
