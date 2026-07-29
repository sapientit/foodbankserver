import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema/index.ts';

/**
 * The Drizzle handle, with `$client` typed as the raw `D1Database`.
 *
 * `$client` is needed for the one operation Drizzle cannot express: bulk
 * inserts that bind a whole row set as a single JSON parameter and expand it
 * with `json_each`, to stay under D1's 100-bound-parameter limit. Drizzle's
 * own `db.batch()` also refuses raw SQL, so those statements go through
 * `db.$client.batch()`. See `pick-lists.repository.ts`.
 */
export type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };

export function createDatabase(binding: D1Database): Database {
  return drizzle(binding, { schema });
}

/**
 * D1 has no interactive transactions — `BEGIN` is an error, because a Worker
 * holding an open transaction from the other side of the world could block the
 * primary indefinitely. `db.batch()` is the only atomicity primitive: the
 * statements commit sequentially and non-concurrently, and any failure rolls
 * the whole sequence back.
 *
 * The consequence for this codebase is a repository contract, documented in
 * CLAUDE.md: for a multi-write operation a repository returns an array of
 * statements, and the service executes exactly one `db.batch([...])`. A
 * repository method that writes and then reads its own write is impossible
 * here — restructure so every value the write needs is known beforehand.
 */
export type BatchStatements = Parameters<Database['batch']>[0];
