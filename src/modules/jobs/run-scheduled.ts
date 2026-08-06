import type { Clock } from '../../core/clock.ts';
import { toSafeError, type Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import { createSessionsRepository } from '../sessions/sessions.repository.ts';
import { createJobsRepository } from './jobs.repository.ts';
import { purgeReferralPii, PURGE_PII_JOB } from './purge-pii.ts';
import { purgeSmsMessages, PURGE_SMS_JOB } from './purge-sms.ts';
import {
  materialiseSessions,
  MATERIALISE_SESSIONS_JOB,
  type MaterialiseResult,
} from './materialise-sessions.ts';

export interface ScheduledResult extends MaterialiseResult {
  readonly referralsPurged: number;
  readonly smsMessagesPurged: number;
}

export interface ScheduledDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Undefined until the charity sets a retention period, in which case the
   * purge runs and reports zero rather than guessing.
   */
  readonly piiRetentionDays?: number | undefined;
}

/**
 * Runs every scheduled job and records the outcome.
 *
 * Shared by the cron handler and the admin trigger route, so the thing that
 * runs unattended at 02:17 is exactly the thing that gets exercised by hand
 * and by tests — not a parallel implementation of it.
 */
export async function runScheduledJobs(deps: ScheduledDeps): Promise<ScheduledResult> {
  const jobs = createJobsRepository(deps.db);
  const startedAt = deps.clock.nowIso();

  try {
    const result = await materialiseSessions({
      db: deps.db,
      repository: createSessionsRepository(deps.db),
      clock: deps.clock,
      logger: deps.logger,
    });

    const pii = await purgeReferralPii({
      db: deps.db,
      clock: deps.clock,
      logger: deps.logger,
      retentionDays: deps.piiRetentionDays,
    });

    // Unconditional, unlike the referral purge: thirty days is a settled
    // requirement rather than a configuration value waiting to be set.
    const sms = await purgeSmsMessages({
      db: deps.db,
      clock: deps.clock,
      logger: deps.logger,
    });

    await jobs.recordSuccess(MATERIALISE_SESSIONS_JOB, startedAt);
    await jobs.recordSuccess(PURGE_SMS_JOB, startedAt);
    if (deps.piiRetentionDays !== undefined) {
      await jobs.recordSuccess(PURGE_PII_JOB, startedAt);
    }

    return { ...result, referralsPurged: pii.purged, smsMessagesPurged: sms.purged };
  } catch (error) {
    const safe = toSafeError(error);
    deps.logger.error('scheduled job failed', {
      jobName: MATERIALISE_SESSIONS_JOB,
      error: safe,
    });
    // Bookkeeping must not mask the original failure, so it gets its own catch.
    await jobs
      .recordFailure(MATERIALISE_SESSIONS_JOB, startedAt, safe.message)
      .catch(() => undefined);
    throw error;
  }
}
