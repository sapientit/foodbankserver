import { lt } from 'drizzle-orm';
import { SMS_MESSAGE_RETENTION_DAYS } from '../../config/constants.ts';
import type { Clock } from '../../core/clock.ts';
import type { Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import { smsMessages } from '../../db/schema/sms.ts';

export const PURGE_SMS_JOB = 'purge-sms-messages';

export interface PurgeSmsResult {
  readonly purged: number;
}

/**
 * Deletes text messages more than thirty days old.
 *
 * ## Why this one runs and the referral purge does not
 *
 * `purgeReferralPii` does nothing until somebody sets a retention period,
 * because the charity has not settled one and deleting a household's details
 * on a guess would be worse than keeping them. This period **is** settled —
 * thirty days, in `INITIAL_SPEC1.txt` — so it is a constant rather than
 * configuration and it runs from the first night.
 *
 * ## Why it deletes rather than nulls
 *
 * The referral purge nulls columns and keeps the row, because `adults`,
 * `children` and the reason become statistics once nobody is identifiable.
 * A text message has nothing underneath it: the body *is* the personal data
 * and an empty row records nothing worth reporting on. So the row goes.
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

  const cutoff = new Date(
    Date.parse(clock.nowIso()) - SMS_MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

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
