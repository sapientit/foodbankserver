import type { Clock } from '../../core/clock.ts';
import { addDays } from '../../core/time/plain-date.ts';
import type { PlatformStatsRepository } from './platform-stats.repository.ts';
import { evaluateDay, hasAnyExceeded, type PlatformStatsDay } from './thresholds.ts';

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
      const rows = await repository.listRange(from, to);
      return rows.map(evaluateDay).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
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

      const rows = await repository.listRange(from, today);
      const daysWithExceededThreshold = rows.map(evaluateDay).filter(hasAnyExceeded).length;

      return { windowDays: ALERT_WINDOW_DAYS, daysWithExceededThreshold };
    },
  };
}

export type PlatformStatsService = ReturnType<typeof createPlatformStatsService>;
