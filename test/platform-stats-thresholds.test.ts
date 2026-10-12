import { describe, expect, it } from 'vitest';
import type { PlatformDailyStats } from '../src/db/schema/platform-stats.ts';
import {
  WARNING_FRACTION_OF_CAP,
  CLOUDFLARE_FREE_PLAN_CAPS,
  evaluateDay,
  hasAnyExceeded,
  sumR2OperationsMonthToDate,
  type MonthToDateR2Operations,
} from '../src/modules/platform-stats/thresholds.ts';

/** A quiet day, nowhere near any cap. */
function quietDay(overrides: Partial<PlatformDailyStats> = {}): PlatformDailyStats {
  return {
    date: '2026-09-10',
    workerRequestsAccountWide: 100,
    workerRequestsThisApp: 100,
    workerErrorsThisApp: 0,
    workerCpuTimeP99Us: 100,
    workerSubrequestsSum: 100,
    workerWallTimeP99Ms: 50,
    d1RowsRead: 100,
    d1RowsWritten: 10,
    d1StorageBytes: 1024,
    r2StorageBytes: 1024,
    r2ClassAOperations: 10,
    r2ClassBOperations: 10,
    collectedAt: '2026-09-11T02:17:00.000Z',
    ...overrides,
  };
}

/** No R2 operations this month so far — the common case for tests that are not about R2. */
const NO_R2_OPERATIONS: MonthToDateR2Operations = {
  r2ClassAOperations: 0,
  r2ClassBOperations: 0,
};

describe('evaluateDay', () => {
  it('marks a capped measure exceeded once it reaches the 80% margin, not before', () => {
    const cap = CLOUDFLARE_FREE_PLAN_CAPS.workerRequestsPerDay;
    const threshold = cap * WARNING_FRACTION_OF_CAP;

    const justBelow = evaluateDay(
      quietDay({ workerRequestsAccountWide: threshold - 1 }),
      NO_R2_OPERATIONS,
    ).workerRequestsAccountWide;
    expect(justBelow.exceeded).toBe(false);

    const atThreshold = evaluateDay(
      quietDay({ workerRequestsAccountWide: threshold }),
      NO_R2_OPERATIONS,
    ).workerRequestsAccountWide;
    expect(atThreshold.exceeded).toBe(true);
    expect(atThreshold.cap).toBe(cap);
    expect(atThreshold.threshold).toBe(threshold);
  });

  it('carries every Cloudflare cap through unchanged', () => {
    const day = evaluateDay(quietDay(), NO_R2_OPERATIONS);
    expect(day.workerCpuTimeP99Us.cap).toBe(CLOUDFLARE_FREE_PLAN_CAPS.workerCpuTimePerInvocationUs);
    expect(day.d1RowsRead.cap).toBe(CLOUDFLARE_FREE_PLAN_CAPS.d1RowsReadPerDay);
    expect(day.d1RowsWritten.cap).toBe(CLOUDFLARE_FREE_PLAN_CAPS.d1RowsWrittenPerDay);
    expect(day.d1StorageBytes.cap).toBe(CLOUDFLARE_FREE_PLAN_CAPS.d1StorageBytesPerDatabase);
    expect(day.workerSubrequestsAvgPerInvocation.cap).toBe(
      CLOUDFLARE_FREE_PLAN_CAPS.workerSubrequestsPerInvocation,
    );
    expect(day.r2StorageBytes.cap).toBe(CLOUDFLARE_FREE_PLAN_CAPS.r2StorageBytes);
    expect(day.r2ClassAOperations.cap).toBe(CLOUDFLARE_FREE_PLAN_CAPS.r2ClassAOperationsPerMonth);
    expect(day.r2ClassBOperations.cap).toBe(CLOUDFLARE_FREE_PLAN_CAPS.r2ClassBOperationsPerMonth);
  });

  it('carries processing time as reference-only — a value and a cap, nothing else', () => {
    // Pete settled 2026-09-13: the recorded P99 mixes every invocation this
    // Worker handles, including its own nightly maintenance run, not just
    // the food bank's own request traffic, so it never marks a day worrying.
    const day = evaluateDay(
      quietDay({ workerCpuTimeP99Us: 10 * CLOUDFLARE_FREE_PLAN_CAPS.workerCpuTimePerInvocationUs }),
      NO_R2_OPERATIONS,
    );
    expect(day.workerCpuTimeP99Us).toEqual({
      value: 10 * CLOUDFLARE_FREE_PLAN_CAPS.workerCpuTimePerInvocationUs,
      cap: CLOUDFLARE_FREE_PLAN_CAPS.workerCpuTimePerInvocationUs,
    });
    expect(day.workerCpuTimeP99Us).not.toHaveProperty('threshold');
    expect(day.workerCpuTimeP99Us).not.toHaveProperty('exceeded');
  });

  it('marks any non-zero Worker error count as exceeded, not a rate past some margin', () => {
    // Pete settled 2026-09-13: one error is worrying on its own.
    const oneError = evaluateDay(
      quietDay({
        workerRequestsAccountWide: 10_000,
        workerRequestsThisApp: 200,
        workerErrorsThisApp: 1,
      }),
      NO_R2_OPERATIONS,
    );
    expect(oneError.workerErrorsThisApp).toEqual({ value: 1, threshold: 0, exceeded: true });

    const noErrors = evaluateDay(quietDay({ workerErrorsThisApp: 0 }), NO_R2_OPERATIONS);
    expect(noErrors.workerErrorsThisApp).toEqual({ value: 0, threshold: 0, exceeded: false });
  });

  it('does not divide by zero on a day with no requests', () => {
    const day = evaluateDay(
      quietDay({ workerRequestsThisApp: 0, workerErrorsThisApp: 0, workerSubrequestsSum: 0 }),
      NO_R2_OPERATIONS,
    );
    expect(day.workerSubrequestsAvgPerInvocation.value).toBe(0);
    expect(day.workerSubrequestsAvgPerInvocation.exceeded).toBe(false);
  });

  it('averages subrequests per invocation rather than summing them against the cap', () => {
    const day = evaluateDay(
      quietDay({ workerRequestsThisApp: 100, workerSubrequestsSum: 4_500 }),
      NO_R2_OPERATIONS,
    );
    expect(day.workerSubrequestsAvgPerInvocation.value).toBeCloseTo(45);
    expect(day.workerSubrequestsAvgPerInvocation.exceeded).toBe(true); // ≥ 40
  });

  it('carries the informational measures with no cap, threshold or exceeded flag', () => {
    const day = evaluateDay(
      quietDay({ workerRequestsThisApp: 77, workerWallTimeP99Ms: 999 }),
      NO_R2_OPERATIONS,
    );
    expect(day.workerRequestsThisApp).toEqual({ value: 77 });
    expect(day.workerWallTimeP99Ms).toEqual({ value: 999 });
  });

  it('compares R2 storage directly to the monthly allowance, not month to date', () => {
    const cap = CLOUDFLARE_FREE_PLAN_CAPS.r2StorageBytes;
    const threshold = cap * WARNING_FRACTION_OF_CAP;

    const day = evaluateDay(quietDay({ r2StorageBytes: threshold }), NO_R2_OPERATIONS);
    expect(day.r2StorageBytes).toEqual({ value: threshold, cap, threshold, exceeded: true });
  });

  it('compares R2 operations to the month-to-date figure the caller supplies, not the row', () => {
    const day = evaluateDay(quietDay({ r2ClassAOperations: 999_999, r2ClassBOperations: 1 }), {
      r2ClassAOperations: 5,
      r2ClassBOperations: 7,
    });
    expect(day.r2ClassAOperations.value).toBe(5);
    expect(day.r2ClassBOperations.value).toBe(7);
  });
});

describe('sumR2OperationsMonthToDate', () => {
  const rows: PlatformDailyStats[] = [
    quietDay({ date: '2026-08-30', r2ClassAOperations: 1000, r2ClassBOperations: 2000 }),
    quietDay({ date: '2026-08-31', r2ClassAOperations: 1000, r2ClassBOperations: 2000 }),
    quietDay({ date: '2026-09-01', r2ClassAOperations: 10, r2ClassBOperations: 20 }),
    quietDay({ date: '2026-09-02', r2ClassAOperations: 10, r2ClassBOperations: 20 }),
    quietDay({ date: '2026-09-03', r2ClassAOperations: 10, r2ClassBOperations: 20 }),
  ];

  it('sums only the requested month, resetting on the 1st', () => {
    const augustTotal = sumR2OperationsMonthToDate(rows, '2026-08-31');
    expect(augustTotal).toEqual({ r2ClassAOperations: 2000, r2ClassBOperations: 4000 });

    const septemberSoFar = sumR2OperationsMonthToDate(rows, '2026-09-02');
    expect(septemberSoFar).toEqual({ r2ClassAOperations: 20, r2ClassBOperations: 40 });
  });

  it('includes every day up to and including `throughDate`, and no later day', () => {
    const total = sumR2OperationsMonthToDate(rows, '2026-09-03');
    expect(total).toEqual({ r2ClassAOperations: 30, r2ClassBOperations: 60 });
  });

  it('is zero for a month with no captured rows', () => {
    expect(sumR2OperationsMonthToDate(rows, '2026-10-01')).toEqual({
      r2ClassAOperations: 0,
      r2ClassBOperations: 0,
    });
  });
});

describe('hasAnyExceeded', () => {
  it('is false when every measure is clear', () => {
    expect(hasAnyExceeded(evaluateDay(quietDay(), NO_R2_OPERATIONS))).toBe(false);
  });

  it('is true when only one capped measure is over its threshold', () => {
    const day = evaluateDay(
      quietDay({ d1StorageBytes: CLOUDFLARE_FREE_PLAN_CAPS.d1StorageBytesPerDatabase }),
      NO_R2_OPERATIONS,
    );
    expect(hasAnyExceeded(day)).toBe(true);
  });

  it('is true the moment there is a single Worker error', () => {
    const day = evaluateDay(
      quietDay({ workerRequestsThisApp: 100, workerErrorsThisApp: 1 }),
      NO_R2_OPERATIONS,
    );
    expect(hasAnyExceeded(day)).toBe(true);
  });

  it('ignores the informational measures — no wall-time spike counts toward the alert', () => {
    const day = evaluateDay(quietDay({ workerWallTimeP99Ms: 999_999 }), NO_R2_OPERATIONS);
    expect(hasAnyExceeded(day)).toBe(false);
  });

  it('ignores processing time no matter how far over the cap it runs', () => {
    // The whole point of making this reference-only: it must never be able
    // to trip the alert on its own, however extreme the reading.
    const day = evaluateDay(
      quietDay({
        workerCpuTimeP99Us: 1000 * CLOUDFLARE_FREE_PLAN_CAPS.workerCpuTimePerInvocationUs,
      }),
      NO_R2_OPERATIONS,
    );
    expect(hasAnyExceeded(day)).toBe(false);
  });

  it('is true when R2 storage alone is over its threshold', () => {
    const day = evaluateDay(
      quietDay({ r2StorageBytes: CLOUDFLARE_FREE_PLAN_CAPS.r2StorageBytes }),
      NO_R2_OPERATIONS,
    );
    expect(hasAnyExceeded(day)).toBe(true);
  });

  it('is true when R2 operations month to date alone are over their threshold', () => {
    const day = evaluateDay(quietDay(), {
      r2ClassAOperations: CLOUDFLARE_FREE_PLAN_CAPS.r2ClassAOperationsPerMonth,
      r2ClassBOperations: 0,
    });
    expect(hasAnyExceeded(day)).toBe(true);
  });
});
