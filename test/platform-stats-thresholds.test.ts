import { describe, expect, it } from 'vitest';
import type { PlatformDailyStats } from '../src/db/schema/platform-stats.ts';
import {
  ASSUMED_WARNING_FRACTION_OF_CAP,
  ASSUMED_WORRYING_ERROR_RATE,
  CLOUDFLARE_FREE_PLAN_CAPS,
  evaluateDay,
  hasAnyExceeded,
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
    collectedAt: '2026-09-11T02:17:00.000Z',
    ...overrides,
  };
}

describe('evaluateDay', () => {
  it('marks a capped measure exceeded once it reaches the assumed 80% margin, not before', () => {
    const cap = CLOUDFLARE_FREE_PLAN_CAPS.workerRequestsPerDay;
    const threshold = cap * ASSUMED_WARNING_FRACTION_OF_CAP;

    const justBelow = evaluateDay(
      quietDay({ workerRequestsAccountWide: threshold - 1 }),
    ).workerRequestsAccountWide;
    expect(justBelow.exceeded).toBe(false);

    const atThreshold = evaluateDay(
      quietDay({ workerRequestsAccountWide: threshold }),
    ).workerRequestsAccountWide;
    expect(atThreshold.exceeded).toBe(true);
    expect(atThreshold.cap).toBe(cap);
    expect(atThreshold.threshold).toBe(threshold);
  });

  it('carries every Cloudflare cap through unchanged', () => {
    const day = evaluateDay(quietDay());
    expect(day.workerCpuTimeP99Us.cap).toBe(CLOUDFLARE_FREE_PLAN_CAPS.workerCpuTimePerInvocationUs);
    expect(day.d1RowsRead.cap).toBe(CLOUDFLARE_FREE_PLAN_CAPS.d1RowsReadPerDay);
    expect(day.d1RowsWritten.cap).toBe(CLOUDFLARE_FREE_PLAN_CAPS.d1RowsWrittenPerDay);
    expect(day.d1StorageBytes.cap).toBe(CLOUDFLARE_FREE_PLAN_CAPS.d1StorageBytesPerDatabase);
    expect(day.workerSubrequestsAvgPerInvocation.cap).toBe(
      CLOUDFLARE_FREE_PLAN_CAPS.workerSubrequestsPerInvocation,
    );
  });

  it('computes the error rate from errors over this app’s own requests, not the account-wide total', () => {
    const day = evaluateDay(
      quietDay({
        workerRequestsAccountWide: 10_000,
        workerRequestsThisApp: 200,
        workerErrorsThisApp: 20,
      }),
    );
    expect(day.workerErrorRateThisApp.value).toBeCloseTo(0.1);
    expect(day.workerErrorRateThisApp.threshold).toBe(ASSUMED_WORRYING_ERROR_RATE);
    expect(day.workerErrorRateThisApp.exceeded).toBe(true);
  });

  it('does not divide by zero on a day with no requests', () => {
    const day = evaluateDay(
      quietDay({ workerRequestsThisApp: 0, workerErrorsThisApp: 0, workerSubrequestsSum: 0 }),
    );
    expect(day.workerErrorRateThisApp.value).toBe(0);
    expect(day.workerErrorRateThisApp.exceeded).toBe(false);
    expect(day.workerSubrequestsAvgPerInvocation.value).toBe(0);
    expect(day.workerSubrequestsAvgPerInvocation.exceeded).toBe(false);
  });

  it('averages subrequests per invocation rather than summing them against the cap', () => {
    const day = evaluateDay(quietDay({ workerRequestsThisApp: 100, workerSubrequestsSum: 4_500 }));
    expect(day.workerSubrequestsAvgPerInvocation.value).toBeCloseTo(45);
    expect(day.workerSubrequestsAvgPerInvocation.exceeded).toBe(true); // ≥ 40
  });

  it('carries the informational measures with no cap, threshold or exceeded flag', () => {
    const day = evaluateDay(quietDay({ workerRequestsThisApp: 77, workerWallTimeP99Ms: 999 }));
    expect(day.workerRequestsThisApp).toEqual({ value: 77 });
    expect(day.workerWallTimeP99Ms).toEqual({ value: 999 });
  });
});

describe('hasAnyExceeded', () => {
  it('is false when every measure is clear', () => {
    expect(hasAnyExceeded(evaluateDay(quietDay()))).toBe(false);
  });

  it('is true when only one capped measure is over its threshold', () => {
    const day = evaluateDay(
      quietDay({ d1StorageBytes: CLOUDFLARE_FREE_PLAN_CAPS.d1StorageBytesPerDatabase }),
    );
    expect(hasAnyExceeded(day)).toBe(true);
  });

  it('is true when only the uncapped error rate is over its assumed margin', () => {
    const day = evaluateDay(quietDay({ workerRequestsThisApp: 100, workerErrorsThisApp: 50 }));
    expect(hasAnyExceeded(day)).toBe(true);
  });

  it('ignores the informational measures — no wall-time spike counts toward the alert', () => {
    const day = evaluateDay(quietDay({ workerWallTimeP99Ms: 999_999 }));
    expect(hasAnyExceeded(day)).toBe(false);
  });
});
