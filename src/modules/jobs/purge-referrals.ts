import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Clock } from '../../core/clock.ts';
import type { Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import { parcels } from '../../db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../../db/schema/referrals.ts';
import { smsMessages } from '../../db/schema/sms.ts';

export const PURGE_REFERRALS_JOB = 'purge-referrals';

export interface PurgeReferralsResult {
  readonly purged: number;
  readonly retentionDays: number | undefined;
}

/**
 * Deletes every referral made longer ago than the retention period.
 *
 * ## Deleted, not anonymised
 *
 * `INITIAL_SPEC1.txt`, `#Forgetting a referral`: the referral is deleted
 * outright and nothing about it survives — not the household's details, not
 * the counts derived from them, not the referrer, not the review comment.
 * The food bank's longer-term reporting comes from the extract spreadsheet,
 * not from here. So the whole row goes, and with it:
 *
 * - its **parcel**, pick-list information and all; the parcel's lines follow
 *   by `ON DELETE CASCADE`;
 * - any **texts** still filed against it (the thirty-day text purge has
 *   usually removed them already, but a referral cannot be deleted while a
 *   row still points at it);
 * - its **audit trail**, which names the referral and the fields changed on it.
 *
 * The session's own figures are not the parcel and **stay**: the session, its
 * pick list and the stock ledger. A ledger row's `parcel_id` has no foreign
 * key on purpose (see `stock.ts`), so what stock moved stands after the parcel
 * it moved for has gone.
 *
 * ## One batch, whatever the volume
 *
 * Every statement selects the expired referrals by the same `referred_at`
 * condition rather than by a list of ids read first, so the work is a fixed
 * four statements in one atomic `db.batch()` however many referrals are due.
 * A statement per referral would exceed the free plan's fifty queries per
 * invocation on a busy night — and fail every night after it, since the
 * backlog would only grow.
 *
 * ## Why it does nothing by default
 *
 * `retentionDays` is undefined unless the period has been configured.
 * Deleting somebody's referral on a guessed period would be worse than doing
 * nothing, so with no configuration this reports zero and stops.
 */
export async function purgeExpiredReferrals(deps: {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly retentionDays: number | undefined;
}): Promise<PurgeReferralsResult> {
  const { db, clock, logger, retentionDays } = deps;

  if (retentionDays === undefined) {
    return { purged: 0, retentionDays };
  }

  const cutoff = new Date(
    Date.parse(clock.nowIso()) - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const expired = db
    .select({ id: referrals.id })
    .from(referrals)
    .where(lt(referrals.referredAt, cutoff));

  // Children first: D1 enforces foreign keys and cannot defer them.
  const [, , , deleted] = await db.batch([
    db
      .delete(auditEvents)
      .where(and(eq(auditEvents.entityType, 'referral'), inArray(auditEvents.entityId, expired))),
    db.delete(smsMessages).where(inArray(smsMessages.referralId, expired)),
    db.delete(parcels).where(inArray(parcels.referralId, expired)),
    db.delete(referrals).where(lt(referrals.referredAt, cutoff)).returning({ id: referrals.id }),
  ]);

  if (deleted.length > 0) {
    logger.info('deleted expired referrals', {
      jobName: PURGE_REFERRALS_JOB,
      count: deleted.length,
    });
  }
  return { purged: deleted.length, retentionDays };
}
