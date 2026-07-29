import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions.ts';
import { users } from './users.ts';

/**
 * Enumerated generously. `donation`, `wastage` and `expiry` are unused in v1,
 * and `parcel_returned` may never be used at all given stock moves on
 * attendance — but extending a CHECK constraint later means rebuilding a
 * ledger that grows by ~47,000 rows a year.
 */
export const STOCK_MOVEMENT_TYPES = [
  'opening_balance',
  'purchase',
  'donation',
  'parcel_issued',
  'parcel_returned',
  'stock_take_adjustment',
  'wastage',
  'expiry',
  'correction',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const STOCK_TAKE_STATUSES = ['open', 'committed', 'abandoned'] as const;
export type StockTakeStatus = (typeof STOCK_TAKE_STATUSES)[number];

export const stockItems = sqliteTable(
  'stock_items',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** `lower(trim(name))`. The autocomplete match column, and the uniqueness key. */
    nameNormalised: text('name_normalised').notNull().unique(),
    /** 'tin', 'packet', 'kg', 'box'. Free text: the charity's vocabulary, not ours. */
    unit: text('unit').notNull(),
    /** As displayed: 'A1', '12b'. Alphanumeric, because shelves are labelled by people. */
    shelfNumber: text('shelf_number').notNull(),
    /** Zero-padded so 'A2' sorts before 'A10'. Computed on write in TypeScript. */
    shelfSortKey: text('shelf_sort_key').notNull(),
    lowStockThreshold: integer('low_stock_threshold'),
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

/** "After a shop": one trip, many lines. */
export const purchases = sqliteTable('purchases', {
  id: text('id').primaryKey(),
  purchasedAt: text('purchased_at').notNull(),
  note: text('note'),
  createdByUserId: text('created_by_user_id')
    .notNull()
    .references(() => users.id),
  createdAt: text('created_at').notNull(),
});

export const purchaseLines = sqliteTable(
  'purchase_lines',
  {
    id: text('id').primaryKey(),
    purchaseId: text('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'cascade' }),
    stockItemId: text('stock_item_id')
      .notNull()
      .references(() => stockItems.id),
    quantity: integer('quantity').notNull(),
  },
  (table) => [
    unique('idx_purchase_lines_item').on(table.purchaseId, table.stockItemId),
    check('purchase_lines_quantity_positive', sql`${table.quantity} > 0`),
  ],
);

export const stockTakes = sqliteTable(
  'stock_takes',
  {
    id: text('id').primaryKey(),
    countedAt: text('counted_at').notNull(),
    status: text('status').$type<StockTakeStatus>().notNull().default('open'),
    note: text('note'),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => users.id),
    committedAt: text('committed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('stock_takes_status_valid', sql`${table.status} IN ('open', 'committed', 'abandoned')`),
  ],
);

export const stockTakeLines = sqliteTable(
  'stock_take_lines',
  {
    id: text('id').primaryKey(),
    stockTakeId: text('stock_take_id')
      .notNull()
      .references(() => stockTakes.id, { onDelete: 'cascade' }),
    stockItemId: text('stock_item_id')
      .notNull()
      .references(() => stockItems.id),
    countedQuantity: integer('counted_quantity').notNull(),
    /** The derived level at commit time. Makes the variance auditable. */
    expectedQuantity: integer('expected_quantity'),
  },
  (table) => [
    unique('idx_stock_take_lines_item').on(table.stockTakeId, table.stockItemId),
    check('stock_take_lines_counted_valid', sql`${table.countedQuantity} >= 0`),
  ],
);

/**
 * The stock ledger. **Append only** — never UPDATE, never DELETE.
 *
 * The current level of an item is `SUM(quantity_delta)`. At roughly 25 parcels
 * × 12 lines × 3 sessions a week the ledger grows by ~47,000 rows a year, and
 * a full-scan SUM over that is milliseconds. **Do not add a balances snapshot
 * table** — that is speculative optimisation, and it introduces a second
 * source of truth that can drift from the ledger.
 *
 * ## The idempotency guards
 *
 * D1 has no interactive transactions, so "move this stock exactly once" cannot
 * be a read-then-write in a service. It is enforced by the partial unique
 * indexes below: a retried or double-tapped submission violates the index, the
 * service catches that specific violation, and treats it as success.
 *
 * The parcel one is the reason this table looks like this. It is what stops a
 * team lead's double-tap decrementing stock twice — the failure nobody notices
 * until a stock take will not reconcile.
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
     * No foreign key, deliberately: `parcels` does not exist until the pick
     * list slice, and SQLite cannot add a constraint to an existing table
     * without rebuilding it — which for an append-only ledger is exactly the
     * migration you do not want to run later. The column and its unique index
     * are created now because slice 8 depends on them.
     */
    parcelId: text('parcel_id'),
    sessionId: text('session_id').references(() => sessions.id),
    purchaseId: text('purchase_id').references(() => purchases.id),
    stockTakeId: text('stock_take_id').references(() => stockTakes.id),

    reason: text('reason'),
    actorUserId: text('actor_user_id').references(() => users.id),
    occurredAt: text('occurred_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_stock_ledger_item').on(table.stockItemId),
    index('idx_stock_ledger_session').on(table.sessionId),

    // ===== THE IDEMPOTENCY GUARDS =====
    // `stockItemId` is part of each key because one parcel, purchase or stock
    // take produces one ledger row *per item*. The partial `WHERE` keeps the
    // indexes small and lets the other movement kinds ignore them entirely.
    uniqueIndex('idx_stock_ledger_parcel_movement')
      .on(table.parcelId, table.stockItemId, table.movementType)
      .where(sql`${table.parcelId} IS NOT NULL`),
    uniqueIndex('idx_stock_ledger_purchase_movement')
      .on(table.purchaseId, table.stockItemId, table.movementType)
      .where(sql`${table.purchaseId} IS NOT NULL`),
    uniqueIndex('idx_stock_ledger_stock_take_movement')
      .on(table.stockTakeId, table.stockItemId, table.movementType)
      .where(sql`${table.stockTakeId} IS NOT NULL`),

    check('stock_ledger_delta_non_zero', sql`${table.quantityDelta} <> 0`),
    check(
      'stock_ledger_movement_type_valid',
      sql`${table.movementType} IN ('opening_balance', 'purchase', 'donation', 'parcel_issued', 'parcel_returned', 'stock_take_adjustment', 'wastage', 'expiry', 'correction')`,
    ),
  ],
);

export const stockItemsRelations = relations(stockItems, ({ many }) => ({
  ledger: many(stockLedger),
}));

export const purchasesRelations = relations(purchases, ({ many }) => ({
  lines: many(purchaseLines),
}));

export const stockTakesRelations = relations(stockTakes, ({ many }) => ({
  lines: many(stockTakeLines),
}));

export type StockItem = typeof stockItems.$inferSelect;
export type NewStockItem = typeof stockItems.$inferInsert;
export type StockLedgerEntry = typeof stockLedger.$inferSelect;
export type NewStockLedgerEntry = typeof stockLedger.$inferInsert;
export type Purchase = typeof purchases.$inferSelect;
export type PurchaseLine = typeof purchaseLines.$inferSelect;
export type StockTake = typeof stockTakes.$inferSelect;
export type StockTakeLine = typeof stockTakeLines.$inferSelect;
