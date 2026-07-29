import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import { systemJobs, type SystemJob } from '../../db/schema/jobs.ts';

/**
 * Bookkeeping so a cron that has silently stopped firing is visible rather
 * than merely absent.
 */
export function createJobsRepository(db: Database) {
  return {
    async find(name: string): Promise<SystemJob | undefined> {
      const rows = await db.select().from(systemJobs).where(eq(systemJobs.name, name)).limit(1);
      return expectAtMostOne(rows);
    },

    async list(): Promise<SystemJob[]> {
      return db.select().from(systemJobs);
    },

    /** One upsert — there is no transaction to wrap a read-then-write in. */
    async recordSuccess(name: string, at: string): Promise<void> {
      await db
        .insert(systemJobs)
        .values({ name, lastRunAt: at, lastSuccessAt: at, lastError: null, runCount: 1 })
        .onConflictDoUpdate({
          target: systemJobs.name,
          set: {
            lastRunAt: at,
            lastSuccessAt: at,
            lastError: null,
            runCount: sql`${systemJobs.runCount} + 1`,
          },
        });
    },

    async recordFailure(name: string, at: string, error: string): Promise<void> {
      await db
        .insert(systemJobs)
        .values({ name, lastRunAt: at, lastSuccessAt: null, lastError: error, runCount: 1 })
        .onConflictDoUpdate({
          target: systemJobs.name,
          set: {
            lastRunAt: at,
            lastError: error,
            runCount: sql`${systemJobs.runCount} + 1`,
          },
        });
    },
  };
}

export type JobsRepository = ReturnType<typeof createJobsRepository>;
