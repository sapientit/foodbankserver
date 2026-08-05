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
 * What an administrator may change after the fact.
 *
 * There is no self-service equivalent any more: a referrer confirms what they
 * sent and phones the food bank if it needs changing. `referrerEmail` is
 * absent deliberately — it is what the authorisation decision was made on, so
 * editing it would leave a referral whose status no longer follows from its
 * address.
 */
export const referralAmendSchema = z
  .object({
    referrerName: fullName,
    referrerPhone: phone.nullable(),
    refereeFirstName: personName,
    refereeSurname: personName,
    refereeDateOfBirth: dateOfBirth,
    refereeAddress: address,
    refereePostcode: postcode,
    refereePhone: phone.nullable(),
    adults: z.number().int().min(1).max(30),
    children: z.number().int().min(0).max(30),
    isDelivery: z.boolean(),
    needsFuelHelp: z.boolean(),
    reasonId: z.uuid(),
    /** Replaces the stored set outright; it is not merged into it. */
    answers,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

export type ReferralAmend = z.infer<typeof referralAmendSchema>;

/**
 * Admins may additionally move a referral to another session.
 *
 * Doing so may exceed capacity, but only when explicitly acknowledged — the
 * spec calls for a warning the operator has to accept, and this is the server
 * half of that.
 */
export const referralAdminAmendSchema = referralAmendSchema.safeExtend({
  sessionId: z.uuid().optional(),
  acknowledgeOverCapacity: z.boolean().default(false),
});

export const cancelReferralSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

/**
 * The administrator's note on why a referral was let through or turned away.
 *
 * One short line. It is overwritten by a later review — there is no history —
 * and it is admin-only on the way out, because it can name a referrer or
 * explain a suspicion.
 */
export const reviewReferralSchema = z.object({
  comment: z.string().trim().min(1).max(200).optional(),
});

export const referralListQuerySchema = z.object({
  sessionId: z.uuid().optional(),
  status: z.enum(REFERRAL_STATUSES).optional(),
});
