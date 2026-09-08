import { asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  crateMembers,
  crates,
  stockTakeGroupings,
  type Crate,
  type CrateMember,
  type NewCrate,
  type NewCrateMember,
} from '../../db/schema/crates.ts';
import { stockItems } from '../../db/schema/stock.ts';
import type { Patch } from '../../core/types.ts';

export interface CrateWithMembers {
  readonly crate: Crate;
  readonly members: CrateMember[];
}

export function createCratesRepository(db: Database) {
  return {
    /**
     * Every crate with its members, in two queries regardless of how many
     * crates there are — the validation report and the stock-take
     * decomposition both want the whole set, and neither is a hot path that
     * needs a narrower query.
     */
    async listCratesWithMembers(): Promise<CrateWithMembers[]> {
      const [crateRows, memberRows] = await Promise.all([
        db.select().from(crates).orderBy(asc(crates.name)),
        db.select().from(crateMembers),
      ]);

      const membersByCrate = new Map<string, CrateMember[]>();
      for (const member of memberRows) {
        const existing = membersByCrate.get(member.crateId);
        if (existing === undefined) membersByCrate.set(member.crateId, [member]);
        else existing.push(member);
      }

      return crateRows.map((crate) => ({ crate, members: membersByCrate.get(crate.id) ?? [] }));
    },

    async findCrateById(id: string): Promise<Crate | undefined> {
      const rows = await db.select().from(crates).where(eq(crates.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    async findMembersByCrateId(crateId: string): Promise<CrateMember[]> {
      return db.select().from(crateMembers).where(eq(crateMembers.crateId, crateId));
    },

    async groupingExists(id: string): Promise<boolean> {
      const rows = await db
        .select({ id: stockTakeGroupings.id })
        .from(stockTakeGroupings)
        .where(eq(stockTakeGroupings.id, id))
        .limit(1);
      return rows.length > 0;
    },

    /**
     * Which of the given stock item ids do not exist — empty if all do. One
     * query for the whole set: `MAX_CRATE_MEMBERS` keeps `ids` well under the
     * bound-parameter limit `inArray` spends one of per id, but a query per id
     * would still be the N+1 this codebase does not allow.
     */
    async missingStockItemIds(ids: readonly string[]): Promise<string[]> {
      if (ids.length === 0) return [];
      const found = await db
        .select({ id: stockItems.id })
        .from(stockItems)
        .where(inArray(stockItems.id, ids));
      const foundIds = new Set(found.map((row) => row.id));
      return ids.filter((id) => !foundIds.has(id));
    },

    async insertCrateWithMembers(crate: NewCrate, members: NewCrateMember[]): Promise<Crate> {
      const [inserted] = await db.batch([
        db.insert(crates).values(crate).returning(),
        db.insert(crateMembers).values(members),
      ]);
      const row = inserted[0];
      if (row === undefined) throw new Error('Failed to insert crate');
      return row;
    },

    /**
     * Updates the crate row and, when `members` is supplied, replaces its
     * membership wholesale — same "one document, one write" pattern as a
     * target stock list's lines. Omit `members` to rename or resize a crate
     * without touching who is in it. `members`, when given, always has at
     * least two entries — `crateInputSchema` guarantees it — so there is no
     * empty-replacement case to special-case here.
     */
    async updateCrateWithMembers(
      id: string,
      patch: Patch<NewCrate>,
      members: NewCrateMember[] | undefined,
    ): Promise<Crate | undefined> {
      if (members === undefined) {
        const rows = await db.update(crates).set(patch).where(eq(crates.id, id)).returning();
        return expectAtMostOne(rows);
      }

      const [updated] = await db.batch([
        db.update(crates).set(patch).where(eq(crates.id, id)).returning(),
        db.delete(crateMembers).where(eq(crateMembers.crateId, id)),
        db.insert(crateMembers).values(members),
      ]);
      return expectAtMostOne(updated);
    },

    async deleteCrate(id: string): Promise<void> {
      // Children first: an immediate foreign-key check on the crate row would
      // otherwise fail while its members still reference it.
      await db.batch([
        db.delete(crateMembers).where(eq(crateMembers.crateId, id)),
        db.delete(crates).where(eq(crates.id, id)),
      ]);
    },
  };
}

export type CratesRepository = ReturnType<typeof createCratesRepository>;
