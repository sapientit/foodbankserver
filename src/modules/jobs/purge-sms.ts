import { lt } from 'drizzle-orm';
import type { Clock } from '../../core/clock.ts';
import type { Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import { smsMessages } from '../../db/schema/sms.ts';
import { smsRetentionCutoffIso } from '../sms/retention.ts';

export const PURGE_SMS_JOB = 'purge-sms-messages';

export interface PurgeSmsResult {
  readonly purged: number;
}

/**
 * Deletes text messages more than thirty days old.
 *
 * ## Why this one always runs and the referral purge waits for configuration
 *
 * `purgeExpiredReferrals` does nothing until `PII_RETENTION_DAYS` is set on
 * the environment, because setting it is what starts deleting referrals. This
 * period is thirty days, in `INITIAL_SPEC1.txt`, and a constant rather than
 * configuration, so it runs from the first night.
 *
 * **Loose replies go the same way**, and that is the point of doing it on
 * `occurredAt` rather than through the referral. A reply from a number with no
 * referral behind it has nothing to count a retention period from, so without
 * this it would sit in the table indefinitely.
 *
 * One statement whatever the volume, so no query-count or parameter limit
 * applies — `DELETE ... WHERE occurred_at < ?` binds one value.
 */
export async function purgeSmsMessages(deps: {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
}): Promise<PurgeSmsResult> {
  const { db, clock, logger } = deps;

  const cutoff = smsRetentionCutoffIso(clock.nowIso());

  const deleted = await db
    .delete(smsMessages)
    .where(lt(smsMessages.occurredAt, cutoff))
    .returning({ id: smsMessages.id });

  if (deleted.length > 0) {
    logger.info('deleted expired text messages', {
      jobName: PURGE_SMS_JOB,
      count: deleted.length,
    });
  }

  return { purged: deleted.length };
}
