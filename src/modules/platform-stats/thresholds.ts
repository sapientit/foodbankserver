import type { PlatformDailyStats } from '../../db/schema/platform-stats.ts';

/**
 * Cloudflare's published free-plan caps. Facts, not guesses — see
 * `INITIAL_SPEC1.txt`, `#Platform usage monitoring`, and Q44 in
 * `OPEN-QUESTIONS.md` for where the guessing actually starts.
 *
 * `workerRequests` is account-wide: it is shared with the unrelated
 * `losttemple-api` Worker on the same account, and exceeding it returns
 * error 1027 for both — see `docs/operations/production.md`.
 */
export const CLOUDFLARE_FREE_PLAN_CAPS = {
  workerRequestsPerDay: 100_000,
  workerCpuTimePerInvocationUs: 10_000,
  workerSubrequestsPerInvocation: 50,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  d1StorageBytesPerDatabase: 500 * 1024 * 1024,
} as const;

/**
 * The assumed margin of a Cloudflare cap that counts as "worrying" — Q44 in
 * `OPEN-QUESTIONS.md`, `x-assumed` in `openapi.yaml`. Pete has not settled
 * this; until they do, one flat 80% stands in for every cap-based measure.
 */
export const ASSUMED_WARNING_FRACTION_OF_CAP = 0.8;

/**
 * The one remaining measure with no Cloudflare cap to take a fraction of at
 * all, so there is no cap-derived number to fall back on even provisionally.
 * Still Q44 — the food bank has never been asked what average subrequest
 * count should count as worrying, since it stands in for a true
 * per-invocation maximum Cloudflare's daily aggregates cannot give.
 */
const ASSUMED_WORRYING_AVG_SUBREQUESTS =
  CLOUDFLARE_FREE_PLAN_CAPS.workerSubrequestsPerInvocation * ASSUMED_WARNING_FRACTION_OF_CAP;

/** A measure with a Cloudflare cap to compare against. */
export interface CappedMeasure {
  readonly value: number;
  readonly cap: number;
  readonly threshold: number;
  readonly exceeded: boolean;
}

/** A measure with an assumed worrying level but no Cloudflare cap behind it. */
export interface UncappedMeasure {
  readonly value: number;
  readonly threshold: number;
  readonly exceeded: boolean;
}

/** A measure carried for context only — no threshold applies. */
export interface InformationalMeasure {
  readonly value: number;
}

/**
 * A measure shown against a Cloudflare cap for reference, but that never
 * marks a day or feeds the fourteen-day alert — currently only processing
 * time. Pete settled this 2026-09-13: the recorded P99 mixes every kind of
 * invocation this Worker handles, including its own nightly maintenance run,
 * not only the requests the food bank's own use produces, so a high reading
 * doesn't mean the food bank is pushing the system toward the cap. See
 * `INITIAL_SPEC1.txt`, `#Platform usage monitoring`.
 */
export interface CapReferenceMeasure {
  readonly value: number;
  readonly cap: number;
}

export interface PlatformStatsDay {
  readonly date: string;
  readonly workerRequestsAccountWide: CappedMeasure;
  readonly workerRequestsThisApp: InformationalMeasure;
  readonly workerErrorsThisApp: UncappedMeasure;
  readonly workerCpuTimeP99Us: CapReferenceMeasure;
  readonly workerSubrequestsAvgPerInvocation: CappedMeasure;
  readonly workerWallTimeP99Ms: InformationalMeasure;
  readonly d1RowsRead: CappedMeasure;
  readonly d1RowsWritten: CappedMeasure;
  readonly d1StorageBytes: CappedMeasure;
}

function capped(value: number, cap: number): CappedMeasure {
  const threshold = cap * ASSUMED_WARNING_FRACTION_OF_CAP;
  return { value, cap, threshold, exceeded: value >= threshold };
}

/**
 * Turns one day's raw counts into the figures the report and the alert
 * actually read. Pure and I/O-free on purpose — this is where Q44's assumed
 * margin actually gets applied, and it is the single place that changes
 * once Pete answers the rest of it.
 *
 * The subrequests measure is an average per invocation
 * (`sum / requests`, or 0 on a day with no requests), standing in for a true
 * per-invocation maximum that Cloudflare's daily aggregates cannot give —
 * see Q44.
 *
 * Processing time (`workerCpuTimeP99Us`) is shown against Cloudflare's cap
 * for reference only — see `CapReferenceMeasure`. The Worker error count is
 * worrying the moment it is non-zero at all, not past some rate; Pete
 * settled both 2026-09-13.
 */
export function evaluateDay(row: PlatformDailyStats): PlatformStatsDay {
  const avgSubrequests =
    row.workerRequestsThisApp === 0 ? 0 : row.workerSubrequestsSum / row.workerRequestsThisApp;

  return {
    date: row.date,
    workerRequestsAccountWide: capped(
      row.workerRequestsAccountWide,
      CLOUDFLARE_FREE_PLAN_CAPS.workerRequestsPerDay,
    ),
    workerRequestsThisApp: { value: row.workerRequestsThisApp },
    workerErrorsThisApp: {
      value: row.workerErrorsThisApp,
      threshold: 0,
      exceeded: row.workerErrorsThisApp > 0,
    },
    workerCpuTimeP99Us: {
      value: row.workerCpuTimeP99Us,
      cap: CLOUDFLARE_FREE_PLAN_CAPS.workerCpuTimePerInvocationUs,
    },
    workerSubrequestsAvgPerInvocation: {
      value: avgSubrequests,
      cap: CLOUDFLARE_FREE_PLAN_CAPS.workerSubrequestsPerInvocation,
      threshold: ASSUMED_WORRYING_AVG_SUBREQUESTS,
      exceeded: avgSubrequests >= ASSUMED_WORRYING_AVG_SUBREQUESTS,
    },
    workerWallTimeP99Ms: { value: row.workerWallTimeP99Ms },
    d1RowsRead: capped(row.d1RowsRead, CLOUDFLARE_FREE_PLAN_CAPS.d1RowsReadPerDay),
    d1RowsWritten: capped(row.d1RowsWritten, CLOUDFLARE_FREE_PLAN_CAPS.d1RowsWrittenPerDay),
    d1StorageBytes: capped(row.d1StorageBytes, CLOUDFLARE_FREE_PLAN_CAPS.d1StorageBytesPerDatabase),
  };
}

/** Whether any measure on this day was worrying enough to count toward the alert. */
export function hasAnyExceeded(day: PlatformStatsDay): boolean {
  return (
    day.workerRequestsAccountWide.exceeded ||
    day.workerErrorsThisApp.exceeded ||
    day.workerSubrequestsAvgPerInvocation.exceeded ||
    day.d1RowsRead.exceeded ||
    day.d1RowsWritten.exceeded ||
    day.d1StorageBytes.exceeded
  );
}
