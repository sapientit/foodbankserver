import { and, asc, eq, isNotNull, like, sql, sum } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  stockItems,
  stockLedger,
  type NewStockItem,
  type StockItem,
} from '../../db/schema/stock.ts';
import type { Patch } from '../../core/types.ts';
import type { StockOrder } from './stock.schema.ts';

export interface StockLevel {
  readonly item: StockItem;
  readonly quantityOnHand: number;
}

export interface IssuedStockUsage {
  readonly stockItemId: string;
  readonly stockItemName: string;
  readonly quantity: number;
}

/**
 * By category, or by shelf.
 *
 * Category order falls back to the name — `name_normalised` rather than `name`,
 * so `beans` and `Beans` do not sort into different places within a group.
 * Shelf order is a plain sort of `shelf_number` exactly as it was typed: the
 * charity does not want the system being clever about numbers inside the label,
 * so `A10` sorts before `A2` and labelling the shelves so the walk comes out
 * right is a warehouse job. No tiebreak — two items on one shelf are in
 * whatever order the shelf has them.
 */
function orderColumns(order: StockOrder) {
  return order === 'category'
    ? [asc(stockItems.category), asc(stockItems.nameNormalised)]
    : [asc(stockItems.shelfNumber)];
}

export function createStockRepository(db: Database) {
  return {
    async findItemById(id: string): Promise<StockItem | undefined> {
      const rows = await db.select().from(stockItems).where(eq(stockItems.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    async listItems(activeOnly: boolean, order: StockOrder): Promise<StockItem[]> {
      return db
        .select()
        .from(stockItems)
        .where(activeOnly ? eq(stockItems.isActive, 1) : undefined)
        .orderBy(...orderColumns(order));
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
    async listLevels(activeOnly: boolean, order: StockOrder): Promise<StockLevel[]> {
      const rows = await db
        .select({ item: stockItems, total: sum(stockLedger.quantityDelta) })
        .from(stockItems)
        .leftJoin(stockLedger, eq(stockLedger.stockItemId, stockItems.id))
        .where(activeOnly ? eq(stockItems.isActive, 1) : undefined)
        .groupBy(stockItems.id)
        .orderBy(...orderColumns(order));

      return rows.map((row) => ({ item: row.item, quantityOnHand: Number(row.total ?? 0) }));
    },

    /**
     * How many active items are currently below their own threshold — the
     * admin dashboard figure. One round trip: the ledger sum per item is a
     * subquery, filtered by `HAVING` against that item's own
     * `low_stock_threshold`, and the outer query only ever returns the count,
     * never a row per item.
     *
     * An item with no threshold set is never "low" — that is what leaving the
     * threshold unset means — so it is excluded before the sum is even taken.
     *
     * `SUM` over an item with no ledger rows at all (never counted) is SQL
     * `NULL`, and `NULL < threshold` is `NULL`, which `HAVING` treats as
     * false — silently dropping an uncounted item from the count even though
     * `listLevels` reports it as `quantityOnHand: 0`. `COALESCE` to zero
     * keeps the two in agreement.
     */
    async countLowStock(): Promise<number> {
      const low = db
        .select({ id: stockItems.id })
        .from(stockItems)
        .leftJoin(stockLedger, eq(stockLedger.stockItemId, stockItems.id))
        .where(and(eq(stockItems.isActive, 1), isNotNull(stockItems.lowStockThreshold)))
        .groupBy(stockItems.id, stockItems.lowStockThreshold)
        .having(
          sql`coalesce(${sum(stockLedger.quantityDelta)}, 0) < ${stockItems.lowStockThreshold}`,
        )
        .as('low_stock_items');

      const rows = await db.select({ count: sql<number>`COUNT(*)` }).from(low);
      return rows[0]?.count ?? 0;
    },

    async levelFor(stockItemId: string): Promise<number> {
      const rows = await db
        .select({ total: sum(stockLedger.quantityDelta) })
        .from(stockLedger)
        .where(eq(stockLedger.stockItemId, stockItemId));
      return Number(rows[0]?.total ?? 0);
    },

    /**
     * What a session's parcels actually took off the shelf, one row per
     * item — for the spreadsheet extract's stock-usage summary
     * (`exports.service.ts`). Only `parcel_issued` movements count, and
     * only this session's: an `opening_balance` or `correction` never
     * carries a `sessionId` so the join already excludes them, but the
     * explicit `movementType` guard is what protects this from a future
     * movement type that does.
     *
     * `quantity_delta` is negative on an issue (see the doc comment on
     * `stockLedger`), so the summed total comes back negative and is
     * negated here into the positive whole number the extract wants. An
     * item is retired by `isActive`, not deleted, so a retired item this
     * session issued still joins and is still named — retirement is not
     * consulted here at all.
     */
    async sumIssuedByItemForSession(sessionId: string): Promise<IssuedStockUsage[]> {
      const rows = await db
        .select({
          stockItemId: stockLedger.stockItemId,
          stockItemName: stockItems.name,
          total: sum(stockLedger.quantityDelta),
        })
        .from(stockLedger)
        .innerJoin(stockItems, eq(stockItems.id, stockLedger.stockItemId))
        .where(
          and(eq(stockLedger.sessionId, sessionId), eq(stockLedger.movementType, 'parcel_issued')),
        )
        .groupBy(stockLedger.stockItemId, stockItems.name);

      // Defensive rather than expected: every parcel_issued row is a
      // negative delta by construction, so the negated sum is always
      // positive whenever there is a row at all. Filtering anyway is what
      // "omit zero-quantity items" means if that ever stops being true.
      return rows
        .map((row) => ({
          stockItemId: row.stockItemId,
          stockItemName: row.stockItemName,
          quantity: -Number(row.total ?? 0),
        }))
        .filter((row) => row.quantity > 0);
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

    /**
     * A team lead's hand correction: one row, written directly rather than
     * through the delete-then-insert `db.$client.batch()` a stock take needs
     * — there is no prior state here to reconcile, so a plain Drizzle insert
     * is enough.
     */
    async insertCorrection(row: {
      id: string;
      stockItemId: string;
      quantityDelta: number;
      occurredAt: string;
    }): Promise<void> {
      await db.insert(stockLedger).values({
        id: row.id,
        stockItemId: row.stockItemId,
        quantityDelta: row.quantityDelta,
        movementType: 'correction',
        parcelId: null,
        sessionId: null,
        // Deliberately null: the charity decided nothing is kept about who
        // made a correction, unlike a stock take's baseline or a parcel
        // issue — INITIAL_SPEC1.txt, "#Stock maintenance".
        actorUserId: null,
        occurredAt: row.occurredAt,
        createdAt: row.occurredAt,
      });
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
