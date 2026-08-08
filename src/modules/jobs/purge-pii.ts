import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Clock } from '../../core/clock.ts';
import type { Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import { referrals } from '../../db/schema/referrals.ts';

export const PURGE_PII_JOB = 'purge-referral-pii';

export interface PurgePiiResult {
  readonly purged: number;
  readonly retentionDays: number | undefined;
}

/**
 * Removes personal data from referrals older than the retention period.
 *
 * ## Why this is safe to run
 *
 * `adults`, `children`, `isDelivery`, `needsFuelHelp` and `reasonId` are
 * deliberately outside the PII block and are **kept**. Once the referee's own
 * columns are null they are no longer identifiable, so those become statistics
 * — which is how "we fed 340 households, 890 people, 22% for benefit delay"
 * survives a purge. That only works because the reason is a dropdown; free text
 * would have to go.
 *
 * ## Only the referee's own details go
 *
 * The referrer's name, email address and phone number are **kept**, along with
 * `reviewComment`. The retention period exists to forget the household that
 * needed feeding, not the professional who referred them: the charity needs to
 * know who sent a referral, and who reviewed it, long after the referral itself
 * has been anonymised. That is the charity's decision — see `INITIAL_SPEC1.txt`
 * — and it is why this list is shorter than the nullable columns on the table.
 *
 * Dynamic answers are dropped **whole**. The referral form is client
 * configuration, so the server has no definition telling it which questions
 * asked for personal data — and an answer that cannot be classified has to be
 * assumed personal. Keeping a key because it looks harmless is the one mistake
 * a purge cannot take back. See Q12 in `OPEN-QUESTIONS.md`.
 *
 * ## Why it does nothing by default
 *
 * `retentionDays` is undefined unless the charity has set a period. Guessing
 * one and deleting somebody's data on that guess would be worse than doing
 * nothing, so with no configuration this reports zero and stops.
 */
export async function purgeReferralPii(deps: {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly retentionDays: number | undefined;
}): Promise<PurgePiiResult> {
  const { db, clock, logger, retentionDays } = deps;

  if (retentionDays === undefined) {
    return { purged: 0, retentionDays };
  }

  const cutoff = new Date(
    Date.parse(clock.nowIso()) - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const candidates = await db
    .select()
    .from(referrals)
    .where(and(lt(referrals.referredAt, cutoff), isNull(referrals.piiPurgedAt)));

  if (candidates.length === 0) {
    return { purged: 0, retentionDays };
  }

  const now = clock.nowIso();
  let purged = 0;

  for (const referral of candidates) {
    await db
      .update(referrals)
      .set({
        refereeFirstName: null,
        refereeSurname: null,
        refereeDateOfBirth: null,
        refereeAddress: null,
        refereePostcode: null,
        refereePhone: null,
        // The settled forms used for repeat-referral matching, alongside the
        // values they are derived from. Missing this is not a bug, it is a
        // data-protection failure: a household the food bank has promised to
        // forget would go on matching by a postcode or phone number it says
        // it no longer holds.
        refereePostcodeNormalised: null,
        refereePhoneNormalised: null,
        answersJson: null,
        piiPurgedAt: now,
        updatedAt: now,
      })
      .where(eq(referrals.id, referral.id));

    purged += 1;
  }

  logger.info('purged referral personal data', { jobName: PURGE_PII_JOB, count: purged });
  return { purged, retentionDays };
}
