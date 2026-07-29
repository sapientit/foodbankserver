import type { Clock } from '../../core/clock.ts';
import type { Logger } from '../../core/log.ts';
import type { ReferralsRepository } from '../referrals/referrals.repository.ts';

export const PURGE_EDIT_KEYS_JOB = 'purge-expired-edit-keys';

/**
 * A key stays for a day after it expires, then goes.
 *
 * The grace period is the point: while the row is still there the handler can
 * answer "your fifteen minutes are up, please phone us" rather than "no such
 * key", which is a much better experience for a referrer who was slow filling
 * the form in. After a day the distinction stops being useful and the row is
 * just a hash nobody needs.
 */
export const EDIT_KEY_GRACE_SECONDS = 24 * 60 * 60;

export interface PurgeEditKeysResult {
  readonly deleted: number;
}

export async function purgeExpiredEditKeys(deps: {
  readonly repository: ReferralsRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}): Promise<PurgeEditKeysResult> {
  const cutoff = deps.clock.nowEpochSeconds() - EDIT_KEY_GRACE_SECONDS;
  const deleted = await deps.repository.deleteExpiredEditKeys(cutoff);

  deps.logger.info('purged expired referral edit keys', {
    jobName: PURGE_EDIT_KEYS_JOB,
    count: deleted,
  });

  return { deleted };
}
