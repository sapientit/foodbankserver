import type { Clock } from '../../core/clock.ts';
import { addDays, startOfMonth } from '../../core/time/plain-date.ts';
import type { PlatformDailyStats } from '../../db/schema/platform-stats.ts';
import type { PlatformStatsRepository } from './platform-stats.repository.ts';
import {
  evaluateDay,
  hasAnyExceeded,
  sumR2OperationsMonthToDate,
  type PlatformStatsDay,
} from './thresholds.ts';

/** How far back the alert looks — settled by Pete, see `INITIAL_SPEC1.txt`. */
const ALERT_WINDOW_DAYS = 14;

export interface AlertSummary {
  readonly windowDays: number;
  readonly daysWithExceededThreshold: number;
}

export interface PlatformStatsServiceDeps {
  readonly repository: PlatformStatsRepository;
  readonly clock: Clock;
}

export function createPlatformStatsService(deps: PlatformStatsServiceDeps) {
  const { repository, clock } = deps;

  return {
    /** Actual figures against Cloudflare's caps, for an administrator-chosen date range. */
    async getUsageReport(from: string, to: string): Promise<PlatformStatsDay[]> {
      const requested = await evaluateRange(repository, from, to);
      return requested.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    },

    /**
     * How many of the last fourteen days had any measure marked worrying.
     *
     * Counted over calendar days that exist in the table, not literally
     * fourteen — a day the job has not yet captured (the feature only just
     * turned on, or a run was missed) does not count as clear, it simply
     * is not there to count either way.
     */
    async getAlertSummary(): Promise<AlertSummary> {
      const today = clock.nowIso().slice(0, 10);
      const from = addDays(today, -(ALERT_WINDOW_DAYS - 1));

      const requested = await evaluateRange(repository, from, today);
      const daysWithExceededThreshold = requested.filter(hasAnyExceeded).length;

      return { windowDays: ALERT_WINDOW_DAYS, daysWithExceededThreshold };
    },
  };
}

/**
 * Evaluates every captured day in `[from, to]`, with each day's R2 operation
 * measures summed month to date — which, for a range starting mid-month,
 * needs days earlier in that month than `from` itself. Reads from the start
 * of `from`'s UTC calendar month through `to` in the one query this needs
 * (`repository.listRange` already covers an arbitrary date range), then
 * returns only the rows actually inside `[from, to]`, each evaluated against
 * the fuller set.
 */
async function evaluateRange(
  repository: PlatformStatsRepository,
  from: string,
  to: string,
): Promise<PlatformStatsDay[]> {
  const monthFloor = startOfMonth(from);
  const rows = await repository.listRange(monthFloor, to);
  const requestedRows = rows.filter(
    (row: PlatformDailyStats) => row.date >= from && row.date <= to,
  );
  return requestedRows.map((row) => evaluateDay(row, sumR2OperationsMonthToDate(rows, row.date)));
}

export type PlatformStatsService = ReturnType<typeof createPlatformStatsService>;
