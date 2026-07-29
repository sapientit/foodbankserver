import { and, asc, eq, like, sql, sum } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  purchaseLines,
  purchases,
  stockItems,
  stockLedger,
  stockTakeLines,
  stockTakes,
  type NewStockItem,
  type NewStockLedgerEntry,
  type Purchase,
  type StockItem,
  type StockTake,
  type StockTakeLine,
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
     * The level is `SUM(quantity_delta)` over the append-only ledger — there
     * is no stored balance to drift.
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

    // ---- Purchases ----

    async findPurchase(id: string): Promise<Purchase | undefined> {
      const rows = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    async listPurchaseLines(purchaseId: string) {
      return db.select().from(purchaseLines).where(eq(purchaseLines.purchaseId, purchaseId));
    },

    // ---- Stock takes ----

    async findStockTake(id: string): Promise<StockTake | undefined> {
      const rows = await db.select().from(stockTakes).where(eq(stockTakes.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    async listStockTakes(): Promise<StockTake[]> {
      return db.select().from(stockTakes).orderBy(asc(stockTakes.countedAt));
    },

    async listStockTakeLines(stockTakeId: string): Promise<StockTakeLine[]> {
      return db.select().from(stockTakeLines).where(eq(stockTakeLines.stockTakeId, stockTakeId));
    },

    async insertStockTake(value: typeof stockTakes.$inferInsert): Promise<StockTake> {
      const rows = await db.insert(stockTakes).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert stock take');
      return inserted;
    },

    async upsertStockTakeLine(value: typeof stockTakeLines.$inferInsert): Promise<void> {
      await db
        .insert(stockTakeLines)
        .values(value)
        .onConflictDoUpdate({
          target: [stockTakeLines.stockTakeId, stockTakeLines.stockItemId],
          set: { countedQuantity: value.countedQuantity },
        });
    },

    async insertLedgerEntry(value: NewStockLedgerEntry): Promise<void> {
      await db.insert(stockLedger).values(value);
    },

    // ---- Statement builders. Compose these, then run ONE db.batch(). ----

    buildInsertPurchase(value: typeof purchases.$inferInsert) {
      return db.insert(purchases).values(value);
    },

    buildInsertPurchaseLine(value: typeof purchaseLines.$inferInsert) {
      return db.insert(purchaseLines).values(value);
    },

    buildInsertLedgerEntry(value: NewStockLedgerEntry) {
      return db.insert(stockLedger).values(value);
    },

    buildCommitStockTake(id: string, at: string) {
      return db
        .update(stockTakes)
        .set({ status: 'committed', committedAt: at, updatedAt: at })
        .where(eq(stockTakes.id, id));
    },

    buildRecordExpected(stockTakeId: string, stockItemId: string, expected: number) {
      return db
        .update(stockTakeLines)
        .set({ expectedQuantity: expected })
        .where(
          and(
            eq(stockTakeLines.stockTakeId, stockTakeId),
            eq(stockTakeLines.stockItemId, stockItemId),
          ),
        );
    },

    /** Levels for a set of items, one query. Used when committing a stock take. */
    async levelsFor(stockItemIds: readonly string[]): Promise<Map<string, number>> {
      if (stockItemIds.length === 0) return new Map();

      const rows = await db
        .select({ stockItemId: stockLedger.stockItemId, total: sum(stockLedger.quantityDelta) })
        .from(stockLedger)
        .where(sql`${stockLedger.stockItemId} IN ${stockItemIds}`)
        .groupBy(stockLedger.stockItemId);

      return new Map(rows.map((row) => [row.stockItemId, Number(row.total ?? 0)]));
    },
  };
}

export type StockRepository = ReturnType<typeof createStockRepository>;
