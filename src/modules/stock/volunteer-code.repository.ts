import { desc, eq, gt, lte } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import { volunteerCodes, type VolunteerCodeRow } from '../../db/schema/volunteer-codes.ts';

/**
 * Storage for stock-take volunteer codes.
 *
 * Multi-write operations return statement builders rather than performing the
 * writes: D1 has no interactive transactions, so the service composes them and
 * runs exactly one `db.batch([...])`. See CLAUDE.md.
 */
export interface NewVolunteerCodeRow {
  readonly id: string;
  readonly codeHash: string;
  readonly createdByUserId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export function createVolunteerCodeRepository(db: Database) {
  return {
    async findByHash(codeHash: string): Promise<VolunteerCodeRow | undefined> {
      const rows = await db
        .select()
        .from(volunteerCodes)
        .where(eq(volunteerCodes.codeHash, codeHash))
        .limit(1);
      return expectAtMostOne(rows);
    },

    /**
     * The most recently generated code that has **not** yet lapsed, for the
     * admin screen's "a fresh code is due" warning. A lapsed code is gone as
     * far as the API is concerned (`INITIAL_SPEC1.txt`, #Stock maintenance —
     * "nothing is kept once it has lapsed"); its row lingers only until the
     * next generate sweeps it, and is never surfaced. `undefined` when no
     * unexpired code exists — before the first is made, or after the last has
     * lapsed. A tie on `created_at` (two codes in the same second) is broken
     * arbitrarily on `id`; the two differ by under a second in every field.
     */
    async findLatestActive(asOf: number): Promise<VolunteerCodeRow | undefined> {
      const rows = await db
        .select()
        .from(volunteerCodes)
        .where(gt(volunteerCodes.expiresAt, asOf))
        .orderBy(desc(volunteerCodes.createdAt), desc(volunteerCodes.id))
        .limit(1);
      return expectAtMostOne(rows);
    },

    // ---- Statement builders. Compose these, then run ONE db.batch(). ----

    buildInsert(row: NewVolunteerCodeRow) {
      return db.insert(volunteerCodes).values(row);
    },

    /**
     * Sweeps lapsed codes. Nothing about a code is kept once it has expired,
     * and this is the only thing that removes one — there is no cancel. The
     * `<=` matches `authenticate`'s own "expired at exactly `expiresAt`" rule,
     * so the two agree on which codes are dead.
     */
    buildDeleteExpired(asOf: number) {
      return db.delete(volunteerCodes).where(lte(volunteerCodes.expiresAt, asOf));
    },
  };
}

export type VolunteerCodeRepository = ReturnType<typeof createVolunteerCodeRepository>;
