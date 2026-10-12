import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * One row per Cloudflare usage day, captured by the nightly job from the
 * GraphQL Analytics API and the D1 REST API. See `INITIAL_SPEC1.txt`,
 * `#Platform usage monitoring`.
 *
 * `date` is a **UTC** calendar date, not a London one — the one deliberate
 * exception to "Europe/London is the only local timezone" in this codebase.
 * This table is not describing anything the charity does; it is describing
 * Cloudflare's own usage day, which resets at UTC midnight regardless of
 * where the food bank is. Storing a London date here would silently disagree
 * with the account dashboard it is meant to be checked against.
 *
 * Raw counts only — no cap, threshold or "exceeded" flag is stored. Those are
 * computed at read time in `thresholds.ts` from constants, so changing the
 * margin never needs a backfill and can never drift row to row.
 */
export const platformDailyStats = sqliteTable('platform_daily_stats', {
  date: text('date').primaryKey(),

  /**
   * Every Worker on the account, not just this one — the 100,000/day cap is
   * account-wide and shared with the unrelated `losttemple-api` Worker.
   */
  workerRequestsAccountWide: integer('worker_requests_account_wide').notNull(),
  /** This app's own script only — context, not itself capped. */
  workerRequestsThisApp: integer('worker_requests_this_app').notNull(),
  workerErrorsThisApp: integer('worker_errors_this_app').notNull(),
  /** P99 CPU time across this app's invocations that day, in microseconds. */
  workerCpuTimeP99Us: integer('worker_cpu_time_p99_us').notNull(),
  /** Sum of subrequests across this app's invocations that day. */
  workerSubrequestsSum: integer('worker_subrequests_sum').notNull(),
  /** P99 wall-clock time across this app's invocations that day, in milliseconds. Informational: the free plan sets no duration cap for HTTP-triggered Workers. */
  workerWallTimeP99Ms: integer('worker_wall_time_p99_ms').notNull(),

  d1RowsRead: integer('d1_rows_read').notNull(),
  d1RowsWritten: integer('d1_rows_written').notNull(),
  /** Snapshot at collection time, from the D1 REST API — not a daily figure. */
  d1StorageBytes: integer('d1_storage_bytes').notNull(),

  /**
   * The R2 measures below back the nightly database export's own free
   * allowance — `INITIAL_SPEC1.txt`, `#Platform usage monitoring`. R2's
   * allowance is account-wide and monthly, not per-bucket or per-day: storage
   * is a snapshot like `d1StorageBytes`, shown directly against the monthly
   * cap, but the two operation counts are *that day's* counts only — the
   * report sums them itself, month to date, in `thresholds.ts`. `DEFAULT 0`
   * backfills the rows captured before this column existed.
   */
  r2StorageBytes: integer('r2_storage_bytes').notNull().default(0),
  /** That day's Class A (write-like) operations — see `r2-operations.ts`. */
  r2ClassAOperations: integer('r2_class_a_operations').notNull().default(0),
  /** That day's Class B (read-like) operations — see `r2-operations.ts`. */
  r2ClassBOperations: integer('r2_class_b_operations').notNull().default(0),

  /** When the job actually ran, as opposed to the usage day it describes. */
  collectedAt: text('collected_at').notNull(),
});

export type PlatformDailyStats = typeof platformDailyStats.$inferSelect;
export type NewPlatformDailyStats = typeof platformDailyStats.$inferInsert;
