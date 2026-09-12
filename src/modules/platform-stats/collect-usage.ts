import type { Clock } from '../../core/clock.ts';
import type { Logger } from '../../core/log.ts';
import { addDays } from '../../core/time/plain-date.ts';
import {
  createCloudflareAnalyticsClient,
  type CloudflareAnalyticsClient,
} from './cloudflare-analytics-client.ts';
import type { PlatformStatsRepository } from './platform-stats.repository.ts';

export const COLLECT_PLATFORM_USAGE_JOB = 'collect-platform-usage';

export interface CollectPlatformUsageResult {
  /** The UTC date collected, or `undefined` when the job was skipped. */
  readonly date: string | undefined;
  readonly collected: boolean;
}

export interface CollectPlatformUsageConfig {
  readonly cfAccountId: string | undefined;
  readonly cfD1DatabaseId: string | undefined;
  readonly cfWorkerScriptName: string | undefined;
  readonly cfAnalyticsApiToken: string | undefined;
}

export interface CollectPlatformUsageDeps {
  readonly repository: PlatformStatsRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: CollectPlatformUsageConfig;
  /** Overridden in tests so no real Cloudflare account is ever needed. */
  readonly analyticsClient?: CloudflareAnalyticsClient;
}

/**
 * Captures **yesterday's** completed Cloudflare usage day — never today's,
 * which is still accumulating when the 02:17 cron runs.
 *
 * Does nothing, like `purgeReferralPii`, until all four settings are
 * present. Guessing an account id would not merely do the wrong thing, it
 * would fail loudly against Cloudflare's API — but leaving three of four set
 * and one missing is exactly the state a half-finished deploy leaves things
 * in, and this should report that plainly rather than half-collecting.
 */
export async function collectPlatformUsage(
  deps: CollectPlatformUsageDeps,
): Promise<CollectPlatformUsageResult> {
  const { cfAccountId, cfD1DatabaseId, cfWorkerScriptName, cfAnalyticsApiToken } = deps.config;

  if (
    cfAccountId === undefined ||
    cfD1DatabaseId === undefined ||
    cfWorkerScriptName === undefined ||
    cfAnalyticsApiToken === undefined
  ) {
    return { date: undefined, collected: false };
  }

  const client =
    deps.analyticsClient ??
    createCloudflareAnalyticsClient({
      accountId: cfAccountId,
      apiToken: cfAnalyticsApiToken,
      workerScriptName: cfWorkerScriptName,
      d1DatabaseId: cfD1DatabaseId,
    });

  // `nowIso()` is UTC, so slicing to 10 chars is already the UTC calendar
  // date — no London conversion here, see `platform-stats.ts`.
  const today = deps.clock.nowIso().slice(0, 10);
  const date = addDays(today, -1);

  const usage = await client.fetchDailyUsage(date);

  await deps.repository.upsert({
    date,
    workerRequestsAccountWide: usage.workerRequestsAccountWide,
    workerRequestsThisApp: usage.workerRequestsThisApp,
    workerErrorsThisApp: usage.workerErrorsThisApp,
    workerCpuTimeP99Us: usage.workerCpuTimeP99Us,
    workerSubrequestsSum: usage.workerSubrequestsSum,
    workerWallTimeP99Ms: usage.workerWallTimeP99Ms,
    d1RowsRead: usage.d1RowsRead,
    d1RowsWritten: usage.d1RowsWritten,
    d1StorageBytes: usage.d1StorageBytes,
    collectedAt: deps.clock.nowIso(),
  });

  deps.logger.info('collected platform usage', { jobName: COLLECT_PLATFORM_USAGE_JOB });

  return { date, collected: true };
}
