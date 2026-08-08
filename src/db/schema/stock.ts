import { relations, sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.ts';
import { users } from './users.ts';

/**
 * The two ways stock moves: the weekly count setting an opening balance, and a
 * parcel going to a household.
 *
 * There is no shop, no donation, no wastage and no hand correction. The charity
 * does not track any of them — the count on the shelf next week says what the
 * stock is, whatever happened to it in between.
 *
 * **This column has now been rebuilt three times**: nine values guessed, then
 * six (migration `0011`), then these two (`0015`). Every one of those rebuilds
 * was caused by guessing what the charity wanted instead of asking. A third
 * value needs an answer, not a reasonable-sounding case.
 */
export const STOCK_MOVEMENT_TYPES = ['opening_balance', 'parcel_issued'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const stockItems = sqliteTable(
  'stock_items',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** `lower(trim(name))`. The autocomplete match column, and the uniqueness key. */
    nameNormalised: text('name_normalised').notNull().unique(),

    /**
     * What the item actually is, in the charity's own words — printed on the
     * pick list beside the name, where 'Pasta' alone does not tell a volunteer
     * that half a kilo counts as one unit. Optional: an item whose name says
     * everything needs no second sentence.
     */
    description: text('description'),

    /**
     * The grouping that the maintenance screen and the pick-list amendment
     * screen sort by, ahead of the name. Free text and no lookup table — there
     * are few enough categories that a table would be a maintenance screen
     * nobody wants.
     *
     * **Stored with its capitalisation standardised** by `stock/category.ts`,
     * so `tinned goods` and `Tinned Goods` are one group rather than two.
     * Nothing else is matched or corrected: two spellings differing by more
     * than case are two categories, and noticing that is an administrator's
     * job, not the server's.
     *
     * The default is for the rows that predate the column — the migration
     * leaves them saying exactly that. Every write goes through the service,
     * which always supplies a value.
     */
    category: text('category').notNull().default('Uncategorised'),

    /** As displayed: 'A1', '12b'. Alphanumeric, because shelves are labelled by people. */
    shelfNumber: text('shelf_number').notNull(),
    /** Zero-padded so 'A2' sorts before 'A10'. Computed on write in TypeScript. */
    shelfSortKey: text('shelf_sort_key').notNull(),
    isActive: integer('is_active').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_stock_items_shelf').on(table.shelfSortKey),
    index('idx_stock_items_name').on(table.nameNormalised),
    check('stock_items_is_active_boolean', sql`${table.isActive} IN (0, 1)`),
  ],
);

/**
 * The stock ledger: **one period, not a history.** Never UPDATE a row.
 *
 * The current level of an item is `SUM(quantity_delta)`, over whatever rows are
 * currently here. **Do not add a balances snapshot table** — that is
 * speculative optimisation, and it introduces a second source of truth that can
 * drift from the ledger.
 *
 * ## Two deletes, and only two
 *
 * This table was append-only, and the rule changed because the requirement did:
 * the charity does not want stock history from before the previous weekly
 * count. So exactly two things delete rows here, both deliberately:
 *
 * 1. **A stock take**, which removes the counted item's rows and writes it a
 *    fresh `opening_balance`. The count supersedes whatever was believed.
 * 2. **Taking an attendance outcome back**, which removes that parcel's rows
 *    and puts the goods back on the shelf.
 *
 * Anything else deleting from here is a bug. An append-only design that kept
 * the same behaviour was considered and rejected; the reasoning, including what
 * it costs, is in `docs/engineering/d1-constraints.md`.
 *
 * ## The idempotency guard
 *
 * D1 has no interactive transactions, so "move this stock exactly once" cannot
 * be a read-then-write in a service. It is enforced by the partial unique index
 * below: a retried or double-tapped submission violates the index, the service
 * catches that specific violation, and treats it as success.
 *
 * That guard is the reason this table looks like this. It is what stops a team
 * lead's double-tap decrementing stock twice — the failure nobody notices until
 * a stock take will not reconcile.
 */
export const stockLedger = sqliteTable(
  'stock_ledger',
  {
    id: text('id').primaryKey(),
    stockItemId: text('stock_item_id')
      .notNull()
      .references(() => stockItems.id),
    /** Signed. Negative issues stock, positive returns or adds it. Never zero. */
    quantityDelta: integer('quantity_delta').notNull(),
    movementType: text('movement_type').$type<StockMovementType>().notNull(),

    /**
     * No foreign key, deliberately: `parcels` did not exist when this column
     * was created, and SQLite cannot add a constraint without rebuilding the
     * table. It stays without one — a stock take deletes rows out from under
     * nothing, but a `parcels` cascade would be a third way rows disappear.
     */
    parcelId: text('parcel_id'),
    sessionId: text('session_id').references(() => sessions.id),

    /** Only on a `parcel_issued` row, and only ever null on a baseline. */
    actorUserId: text('actor_user_id').references(() => users.id),
    occurredAt: text('occurred_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_stock_ledger_item').on(table.stockItemId),
    index('idx_stock_ledger_session').on(table.sessionId),

    // ===== THE IDEMPOTENCY GUARD =====
    // `stockItemId` is part of the key because one parcel produces one ledger
    // row *per item*. The partial `WHERE` keeps the index small and lets a
    // baseline row ignore it entirely.
    //
    // There were three of these, for parcels, purchases and stock takes. The
    // other two went with the movements they guarded: a stock take no longer
    // needs one because a repeated save deletes what the previous save wrote
    // and rewrites it, which is idempotent without an index to enforce it.
    uniqueIndex('idx_stock_ledger_parcel_movement')
      .on(table.parcelId, table.stockItemId, table.movementType)
      .where(sql`${table.parcelId} IS NOT NULL`),

    check('stock_ledger_delta_non_zero', sql`${table.quantityDelta} <> 0`),
    check(
      'stock_ledger_movement_type_valid',
      sql`${table.movementType} IN ('opening_balance', 'parcel_issued')`,
    ),
  ],
);

export const stockItemsRelations = relations(stockItems, ({ many }) => ({
  ledger: many(stockLedger),
}));

export type StockItem = typeof stockItems.$inferSelect;
export type NewStockItem = typeof stockItems.$inferInsert;
export type StockLedgerEntry = typeof stockLedger.$inferSelect;
export type NewStockLedgerEntry = typeof stockLedger.$inferInsert;
