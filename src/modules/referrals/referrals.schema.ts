import { z } from 'zod';
import { MAX_ANSWERS, MAX_ANSWERS_BYTES, MAX_ANSWER_KEY_LENGTH } from '../../config/constants.ts';

/**
 * Required-ness for personal data lives **here**, not in the DDL.
 *
 * The database columns are nullable so a purge can null them in place —
 * SQLite has no `ALTER COLUMN`, so a `NOT NULL` personal-data column could
 * never be purged. This schema is the only route by which a referral is
 * created, so it is where "a referee must have a name" is enforced.
 */

const name = z.string().trim().min(1).max(200);
const address = z.string().trim().min(1).max(500);
const postcode = z.string().trim().min(2).max(12);
const phone = z.string().trim().min(5).max(30);

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

  referrerEmail: z.email().max(254),
  referrerPhone: phone.optional(),

  refereeName: name,
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

  answers: answers.default({}),
});

export type ReferralSubmission = z.infer<typeof referralSubmissionSchema>;

/** What the referrer may change within their 15-minute window. */
export const referralSelfAmendSchema = z
  .object({
    refereeName: name,
    refereeAddress: address,
    refereePostcode: postcode,
    refereePhone: phone.nullable(),
    referrerPhone: phone.nullable(),
    adults: z.number().int().min(1).max(30),
    children: z.number().int().min(0).max(30),
    isDelivery: z.boolean(),
    reasonId: z.uuid(),
    /** Replaces the stored set outright; it is not merged into it. */
    answers,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

export type ReferralSelfAmend = z.infer<typeof referralSelfAmendSchema>;

/**
 * Admins may additionally move a referral to another session.
 *
 * Doing so may exceed capacity, but only when explicitly acknowledged — the
 * spec calls for a warning the operator has to accept, and this is the server
 * half of that.
 */
export const referralAdminAmendSchema = referralSelfAmendSchema.safeExtend({
  sessionId: z.uuid().optional(),
  acknowledgeOverCapacity: z.boolean().default(false),
});

export const cancelReferralSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

export const referralListQuerySchema = z.object({
  sessionId: z.uuid().optional(),
  status: z.enum(['active', 'cancelled']).optional(),
});
