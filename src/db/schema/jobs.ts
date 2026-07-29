import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Bookkeeping for scheduled work: session materialisation and expired-key
 * cleanup. Gives the admin job endpoints something to report, and makes a
 * cron that has silently stopped firing visible.
 */
export const systemJobs = sqliteTable('system_jobs', {
  name: text('name').primaryKey(),
  lastRunAt: text('last_run_at'),
  lastSuccessAt: text('last_success_at'),
  lastError: text('last_error'),
  runCount: integer('run_count').notNull().default(0),
});

export type SystemJob = typeof systemJobs.$inferSelect;
