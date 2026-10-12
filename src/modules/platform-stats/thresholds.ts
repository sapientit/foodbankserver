import type { PlatformDailyStats } from '../../db/schema/platform-stats.ts';

/**
 * Cloudflare's published free-plan caps. Facts, not the charity's choice —
 * see `INITIAL_SPEC1.txt`, `#Platform usage monitoring`.
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
  /**
   * R2's free allowance, account-wide: 10 GB-month storage, 1,000,000 Class A
   * operations/month, 10,000,000 Class B operations/month. Cloudflare's
   * pricing page does not say whether its GB is 10^9 or 2^30 bytes (checked
   * 2026-10-12), so this takes the smaller, decimal one: the report then warns
   * slightly early rather than slightly late.
   */
  r2StorageBytes: 10 * 1_000_000_000,
  r2ClassAOperationsPerMonth: 1_000_000,
  r2ClassBOperationsPerMonth: 10_000_000,
} as const;

/**
 * The margin of a Cloudflare cap that counts as "worrying": one flat 80% for
 * every cap-based measure. Pete settled this 2026-09-29 as a starting point,
 * to be revisited once real usage has been seen.
 */
export const WARNING_FRACTION_OF_CAP = 0.8;

/**
 * An average of 40 subrequests per invocation — the same 80% of the
 * 50-per-invocation cap, applied to an average that stands in for the true
 * per-invocation maximum Cloudflare's daily aggregates cannot give. Settled
 * with the flat margin above, 2026-09-29.
 */
const WORRYING_AVG_SUBREQUESTS =
  CLOUDFLARE_FREE_PLAN_CAPS.workerSubrequestsPerInvocation * WARNING_FRACTION_OF_CAP;

/** A measure with a Cloudflare cap to compare against. */
export interface CappedMeasure {
  readonly value: number;
  readonly cap: number;
  readonly threshold: number;
  readonly exceeded: boolean;
}

/** A measure with a worrying level but no Cloudflare cap behind it. */
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
  /** That day's snapshot, compared directly to the monthly storage allowance. */
  readonly r2StorageBytes: CappedMeasure;
  /** Month to date, compared to the monthly allowance — see `sumR2OperationsMonthToDate`. */
  readonly r2ClassAOperations: CappedMeasure;
  /** Month to date, compared to the monthly allowance — see `sumR2OperationsMonthToDate`. */
  readonly r2ClassBOperations: CappedMeasure;
}

/** This day's two R2 operation counts, summed across its UTC calendar month so far. */
export interface MonthToDateR2Operations {
  readonly r2ClassAOperations: number;
  readonly r2ClassBOperations: number;
}

function capped(value: number, cap: number): CappedMeasure {
  const threshold = cap * WARNING_FRACTION_OF_CAP;
  return { value, cap, threshold, exceeded: value >= threshold };
}

/**
 * Turns one day's raw counts into the figures the report and the alert
 * actually read. Pure and I/O-free on purpose — this is where the margin
 * gets applied, and the single place that changes if the charity revisits it.
 *
 * The subrequests measure is an average per invocation
 * (`sum / requests`, or 0 on a day with no requests), standing in for a true
 * per-invocation maximum that Cloudflare's daily aggregates cannot give.
 *
 * Processing time (`workerCpuTimeP99Us`) is shown against Cloudflare's cap
 * for reference only — see `CapReferenceMeasure`. The Worker error count is
 * worrying the moment it is non-zero at all, not past some rate; Pete
 * settled both 2026-09-13.
 *
 * `monthToDateR2` is the caller's responsibility, not this function's,
 * because it depends on every row captured earlier in `row`'s UTC month —
 * data this single-row function never sees. See `sumR2OperationsMonthToDate`
 * and `platform-stats.service.ts`, which reads those earlier rows before
 * calling this. `r2StorageBytes` needs no such sum: it is a snapshot, so
 * `row`'s own value is compared to the cap directly, same as `d1StorageBytes`.
 */
export function evaluateDay(
  row: PlatformDailyStats,
  monthToDateR2: MonthToDateR2Operations,
): PlatformStatsDay {
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
      threshold: WORRYING_AVG_SUBREQUESTS,
      exceeded: avgSubrequests >= WORRYING_AVG_SUBREQUESTS,
    },
    workerWallTimeP99Ms: { value: row.workerWallTimeP99Ms },
    d1RowsRead: capped(row.d1RowsRead, CLOUDFLARE_FREE_PLAN_CAPS.d1RowsReadPerDay),
    d1RowsWritten: capped(row.d1RowsWritten, CLOUDFLARE_FREE_PLAN_CAPS.d1RowsWrittenPerDay),
    d1StorageBytes: capped(row.d1StorageBytes, CLOUDFLARE_FREE_PLAN_CAPS.d1StorageBytesPerDatabase),
    r2StorageBytes: capped(row.r2StorageBytes, CLOUDFLARE_FREE_PLAN_CAPS.r2StorageBytes),
    r2ClassAOperations: capped(
      monthToDateR2.r2ClassAOperations,
      CLOUDFLARE_FREE_PLAN_CAPS.r2ClassAOperationsPerMonth,
    ),
    r2ClassBOperations: capped(
      monthToDateR2.r2ClassBOperations,
      CLOUDFLARE_FREE_PLAN_CAPS.r2ClassBOperationsPerMonth,
    ),
  };
}

/**
 * Sums a day's two R2 operation counts across every row already captured in
 * that day's UTC calendar month, up to and including the day itself — the
 * month-to-date figure the report and alert compare against R2's monthly
 * allowance.
 *
 * `rows` may, and for a report starting mid-month must, include days earlier
 * in the month than any date the caller is otherwise showing: the caller
 * (`platform-stats.service.ts`) reads those earlier days specifically so this
 * sum is correct from the first day of the range, not just from whichever
 * day the range happens to start on.
 */
export function sumR2OperationsMonthToDate(
  rows: readonly PlatformDailyStats[],
  throughDate: string,
): MonthToDateR2Operations {
  const month = throughDate.slice(0, 7);
  const inMonthSoFar = rows.filter(
    (row) => row.date.slice(0, 7) === month && row.date <= throughDate,
  );
  return {
    r2ClassAOperations: inMonthSoFar.reduce((sum, row) => sum + row.r2ClassAOperations, 0),
    r2ClassBOperations: inMonthSoFar.reduce((sum, row) => sum + row.r2ClassBOperations, 0),
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
    day.d1StorageBytes.exceeded ||
    day.r2StorageBytes.exceeded ||
    day.r2ClassAOperations.exceeded ||
    day.r2ClassBOperations.exceeded
  );
}
