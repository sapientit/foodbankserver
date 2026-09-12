import { and, gte, lte } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { platformDailyStats, type PlatformDailyStats } from '../../db/schema/platform-stats.ts';

/**
 * Storage for the platform-usage table. See `INITIAL_SPEC1.txt`,
 * `#Platform usage monitoring`.
 */
export function createPlatformStatsRepository(db: Database) {
  return {
    /**
     * One upsert per day, keyed on the date — a re-run for a date already
     * captured (a retried cron, or the job triggered by hand) replaces that
     * day's figures rather than duplicating them.
     */
    async upsert(row: PlatformDailyStats): Promise<void> {
      await db.insert(platformDailyStats).values(row).onConflictDoUpdate({
        target: platformDailyStats.date,
        set: row,
      });
    },

    async listRange(from: string, to: string): Promise<PlatformDailyStats[]> {
      return db
        .select()
        .from(platformDailyStats)
        .where(and(gte(platformDailyStats.date, from), lte(platformDailyStats.date, to)));
    },
  };
}

export type PlatformStatsRepository = ReturnType<typeof createPlatformStatsRepository>;
