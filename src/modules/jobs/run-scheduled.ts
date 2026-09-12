import type { Clock } from '../../core/clock.ts';
import { toSafeError, type Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import type { CloudflareAnalyticsClient } from '../platform-stats/cloudflare-analytics-client.ts';
import {
  collectPlatformUsage,
  COLLECT_PLATFORM_USAGE_JOB,
} from '../platform-stats/collect-usage.ts';
import { createPlatformStatsRepository } from '../platform-stats/platform-stats.repository.ts';
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
  /** `undefined` when the platform-usage settings are not all configured yet. */
  readonly platformUsageDate: string | undefined;
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
  /**
   * The platform-usage job's four settings — see `config/env.ts`. All
   * undefined until a deployment sets them, in which case the job is
   * skipped rather than guessing an account id.
   */
  readonly cfAccountId?: string | undefined;
  readonly cfD1DatabaseId?: string | undefined;
  readonly cfWorkerScriptName?: string | undefined;
  readonly cfAnalyticsApiToken?: string | undefined;
  /** Overridden in tests so no real Cloudflare account is ever needed. */
  readonly analyticsClient?: CloudflareAnalyticsClient;
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

  let core: MaterialiseResult & { referralsPurged: number; smsMessagesPurged: number };
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

    core = { ...result, referralsPurged: pii.purged, smsMessagesPurged: sms.purged };
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

  // Deliberately outside the block above and never rethrown: a Cloudflare
  // Analytics API outage is a monitoring gap, not a reason to report
  // tonight's session materialisation, PII purge and SMS purge as failed —
  // those already succeeded by the time this runs.
  let platformUsageDate: string | undefined;
  try {
    const usage = await collectPlatformUsage({
      repository: createPlatformStatsRepository(deps.db),
      clock: deps.clock,
      logger: deps.logger,
      config: {
        cfAccountId: deps.cfAccountId,
        cfD1DatabaseId: deps.cfD1DatabaseId,
        cfWorkerScriptName: deps.cfWorkerScriptName,
        cfAnalyticsApiToken: deps.cfAnalyticsApiToken,
      },
      ...(deps.analyticsClient === undefined ? {} : { analyticsClient: deps.analyticsClient }),
    });
    platformUsageDate = usage.date;
    if (usage.collected) {
      await jobs.recordSuccess(COLLECT_PLATFORM_USAGE_JOB, startedAt);
    }
  } catch (error) {
    const safe = toSafeError(error);
    deps.logger.error('scheduled job failed', { jobName: COLLECT_PLATFORM_USAGE_JOB, error: safe });
    await jobs
      .recordFailure(COLLECT_PLATFORM_USAGE_JOB, startedAt, safe.message)
      .catch(() => undefined);
  }

  return { ...core, platformUsageDate };
}
