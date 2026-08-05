/**
 * Time as a dependency.
 *
 * Services never call `new Date()` or `Date.now()` directly — they take a
 * `Clock`. That is what makes token expiry, the eight-hour sign-in and the
 * 6-week session horizon testable without fake timers, which do not work in
 * the Workers test runner.
 *
 * Workers gotcha: `Date.now()` does not advance during a request until I/O
 * occurs, so two consecutive calls return the same value. Never write code
 * that measures elapsed time inside a handler.
 */
export interface Clock {
  /** Current instant as an ISO-8601 UTC string — the storage format for timestamps. */
  nowIso(): string;
  /** Current instant as epoch seconds — the format for token and key expiries. */
  nowEpochSeconds(): number;
}

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  nowEpochSeconds: () => Math.floor(Date.now() / 1000),
};

/** A clock pinned to a fixed instant. Tests only. */
export function fixedClock(instant: string): Clock {
  const epochMs = Date.parse(instant);
  if (Number.isNaN(epochMs)) {
    throw new Error(`fixedClock: not a valid instant: ${instant}`);
  }
  return {
    nowIso: () => new Date(epochMs).toISOString(),
    nowEpochSeconds: () => Math.floor(epochMs / 1000),
  };
}
