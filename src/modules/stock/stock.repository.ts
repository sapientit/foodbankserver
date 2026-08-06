import { and, asc, eq, like, sum } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  stockItems,
  stockLedger,
  type NewStockItem,
  type StockItem,
} from '../../db/schema/stock.ts';
import type { Patch } from '../../core/types.ts';

export interface StockLevel {
  readonly item: StockItem;
  readonly quantityOnHand: number;
}

export function createStockRepository(db: Database) {
  return {
    async findItemById(id: string): Promise<StockItem | undefined> {
      const rows = await db.select().from(stockItems).where(eq(stockItems.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    async listItems(activeOnly: boolean): Promise<StockItem[]> {
      return db
        .select()
        .from(stockItems)
        .where(activeOnly ? eq(stockItems.isActive, 1) : undefined)
        .orderBy(asc(stockItems.shelfSortKey));
    },

    /**
     * Every item with its derived level, **in one query**.
     *
     * This is the stock-take screen and the picker's list. A per-item level
     * query would be ~40 queries and blow the free-tier budget on a page that
     * gets opened constantly.
     *
     * The level is `SUM(quantity_delta)` over whatever rows the ledger
     * currently holds — there is no stored balance to drift.
     */
    async listLevels(activeOnly: boolean): Promise<StockLevel[]> {
      const rows = await db
        .select({ item: stockItems, total: sum(stockLedger.quantityDelta) })
        .from(stockItems)
        .leftJoin(stockLedger, eq(stockLedger.stockItemId, stockItems.id))
        .where(activeOnly ? eq(stockItems.isActive, 1) : undefined)
        .groupBy(stockItems.id)
        .orderBy(asc(stockItems.shelfSortKey));

      return rows.map((row) => ({ item: row.item, quantityOnHand: Number(row.total ?? 0) }));
    },

    async levelFor(stockItemId: string): Promise<number> {
      const rows = await db
        .select({ total: sum(stockLedger.quantityDelta) })
        .from(stockLedger)
        .where(eq(stockLedger.stockItemId, stockItemId));
      return Number(rows[0]?.total ?? 0);
    },

    /**
     * Autocomplete. Prefix first so the index on `name_normalised` is used;
     * only if that finds nothing does it fall back to an infix scan, which at
     * ~40 items is free. FTS5 would be absurd at this scale.
     */
    async searchItems(term: string): Promise<StockItem[]> {
      const normalised = term.trim().toLowerCase();

      const prefix = await db
        .select()
        .from(stockItems)
        .where(and(eq(stockItems.isActive, 1), like(stockItems.nameNormalised, `${normalised}%`)))
        .orderBy(asc(stockItems.nameNormalised))
        .limit(20);

      if (prefix.length > 0) return prefix;

      return db
        .select()
        .from(stockItems)
        .where(and(eq(stockItems.isActive, 1), like(stockItems.nameNormalised, `%${normalised}%`)))
        .orderBy(asc(stockItems.nameNormalised))
        .limit(20);
    },

    async insertItem(value: NewStockItem): Promise<StockItem> {
      const rows = await db.insert(stockItems).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert stock item');
      return inserted;
    },

    async updateItem(id: string, patch: Patch<NewStockItem>): Promise<StockItem | undefined> {
      const rows = await db.update(stockItems).set(patch).where(eq(stockItems.id, id)).returning();
      return expectAtMostOne(rows);
    },

    async listLedgerFor(stockItemId: string) {
      return db
        .select()
        .from(stockLedger)
        .where(eq(stockLedger.stockItemId, stockItemId))
        .orderBy(asc(stockLedger.occurredAt));
    },

    // ---- The stock take. Two raw D1 statements, run as ONE db.$client.batch().
    //
    // Raw rather than Drizzle for the reason set out in
    // `docs/engineering/d1-constraints.md`: D1 allows 100 bound parameters per
    // statement, and `inArray` binds one per id, so the obvious Drizzle spelling
    // fails somewhere north of a hundred items. Binding the set as a single JSON
    // value and expanding it with `json_each` is one parameter whatever the
    // count. This and `pick-lists.repository.ts` are the only two places that
    // step outside Drizzle, and both are covered by integration tests.

    /**
     * **Deletes the counted items' history.** The highest-stakes statement in
     * this module: what it removes cannot be recovered, because a stock take
     * supersedes rather than adjusts and D1's Time Travel restores the whole
     * database or nothing.
     *
     * The blast radius is bounded by the next count, which restates every level
     * from physical stock — that is the trade that was made deliberately when
     * the ledger stopped being append-only.
     */
    buildDeleteHistoryFor(stockItemIds: readonly string[]): D1PreparedStatement {
      return db.$client
        .prepare(
          `DELETE FROM stock_ledger
            WHERE stock_item_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(JSON.stringify(stockItemIds));
    },

    /** One `opening_balance` per counted item, in one statement. */
    buildInsertBaselines(
      rows: readonly {
        id: string;
        stockItemId: string;
        quantityDelta: number;
      }[],
      input: { actorUserId: string | null; occurredAt: string },
    ): D1PreparedStatement {
      return db.$client
        .prepare(
          `INSERT INTO stock_ledger
             (id, stock_item_id, quantity_delta, movement_type, parcel_id, session_id,
              actor_user_id, occurred_at, created_at)
           SELECT
             json_extract(value, '$.id'),
             json_extract(value, '$.stockItemId'),
             json_extract(value, '$.quantityDelta'),
             'opening_balance', NULL, NULL, ?2, ?3, ?3
           FROM json_each(?1)`,
        )
        .bind(JSON.stringify(rows), input.actorUserId, input.occurredAt);
    },
  };
}

export type StockRepository = ReturnType<typeof createStockRepository>;
