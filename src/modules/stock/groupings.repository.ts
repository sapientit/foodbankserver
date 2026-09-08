import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  stockTakeGroupings,
  type NewStockTakeGrouping,
  type StockTakeGrouping,
} from '../../db/schema/crates.ts';
import type { Patch } from '../../core/types.ts';

export function createGroupingsRepository(db: Database) {
  return {
    async listGroupings(): Promise<StockTakeGrouping[]> {
      return db.select().from(stockTakeGroupings).orderBy(asc(stockTakeGroupings.name));
    },

    async insertGrouping(value: NewStockTakeGrouping): Promise<StockTakeGrouping> {
      const rows = await db.insert(stockTakeGroupings).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert stock-take grouping');
      return inserted;
    },

    async updateGrouping(
      id: string,
      patch: Patch<NewStockTakeGrouping>,
    ): Promise<StockTakeGrouping | undefined> {
      const rows = await db
        .update(stockTakeGroupings)
        .set(patch)
        .where(eq(stockTakeGroupings.id, id))
        .returning();
      return expectAtMostOne(rows);
    },
  };
}

export type GroupingsRepository = ReturnType<typeof createGroupingsRepository>;
