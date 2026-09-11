import { z } from 'zod';
import { referralSubmissionSchema } from '../referrals/referrals.schema.ts';

/**
 * Keeps one import call's D1 query count comfortably inside the free-plan
 * ceiling of 50 per invocation (`docs/engineering/d1-constraints.md`). A call
 * costs 5 reads up front (`findByImportKey`, the session, the reason, and the
 * two capacity counts) plus one `db.batch()` of `1 + referrals.length`
 * statements (the tracking row, then one insert per referral) — 5 + 1 + 30 =
 * 36 at this cap, leaving real headroom rather than the four or five spare
 * queries a cap of 40 would leave. That margin matters because **whether a
 * batch of N statements counts as 1 query or N against the ceiling is not
 * settled anywhere this codebase can check** — this sizing assumes the worse
 * case (N) rather than guessing the better one. An engineering safety limit,
 * not a requirement of the shape of a test scenario.
 */
const MAX_IMPORT_REFERRALS = 30;

/**
 * The one email field a referral carries. Restricted to `example.test` here
 * only — never for a real submission — as this route's defence-in-depth: the
 * dev/test-only deployment gate is not meant to be the sole protection
 * against a real address ever reaching it.
 */
const testEmail = z
  .email()
  .max(254)
  .refine((value) => value.toLowerCase().endsWith('@example.test'), {
    message: 'must be an example.test address; this route never accepts a real email',
  });

/**
 * One prepared, anonymised scenario. The same shape a real submission is
 * validated against — `referralSubmissionSchema` — minus `sessionId` and
 * `reasonId`, both shared across the whole import and supplied once at the
 * top level, and with `referrerEmail` narrowed to `example.test`.
 */
export const importReferralSchema = referralSubmissionSchema
  .omit({ sessionId: true, reasonId: true })
  .extend({ referrerEmail: testEmail });

export type ImportReferral = z.infer<typeof importReferralSchema>;

export const referralImportRequestSchema = z.object({
  /** The client's stable key for this run — see `dev-test-imports.service.ts`. */
  importKey: z.uuid(),
  sessionId: z.uuid(),
  reasonId: z.uuid(),
  referrals: z.array(importReferralSchema).min(1).max(MAX_IMPORT_REFERRALS),
});

export type ReferralImportRequest = z.infer<typeof referralImportRequestSchema>;
