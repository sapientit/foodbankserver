import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  targetStockLists,
  type NewTargetStockListRow,
  type TargetStockListRow,
} from '../../db/schema/target-stock-lists.ts';
import type { Patch } from '../../core/types.ts';

export function createTargetStockListsRepository(db: Database) {
  return {
    /** Every target stock list. One query — there are only ever a handful. */
    async listTargetStockLists(): Promise<TargetStockListRow[]> {
      return db.select().from(targetStockLists).orderBy(asc(targetStockLists.name));
    },

    async findTargetStockListById(id: string): Promise<TargetStockListRow | undefined> {
      const rows = await db
        .select()
        .from(targetStockLists)
        .where(eq(targetStockLists.id, id))
        .limit(1);
      return expectAtMostOne(rows);
    },

    async insertTargetStockList(value: NewTargetStockListRow): Promise<TargetStockListRow> {
      const rows = await db.insert(targetStockLists).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert target stock list');
      return inserted;
    },

    async updateTargetStockList(
      id: string,
      patch: Patch<NewTargetStockListRow>,
    ): Promise<TargetStockListRow | undefined> {
      const rows = await db
        .update(targetStockLists)
        .set(patch)
        .where(eq(targetStockLists.id, id))
        .returning();
      return expectAtMostOne(rows);
    },

    async deleteTargetStockList(id: string): Promise<void> {
      await db.delete(targetStockLists).where(eq(targetStockLists.id, id));
    },
  };
}

export type TargetStockListsRepository = ReturnType<typeof createTargetStockListsRepository>;
