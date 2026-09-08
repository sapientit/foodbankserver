import { relations, sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { stockItems } from './stock.ts';

/**
 * What the grouped stock-take screen and the pick list both sort a stock item
 * under, ahead of `category` — "Non-perishable", "Fresh", and so on. A proper
 * table rather than free text like `category`, because a crate belongs to
 * exactly one and the relationship needs an id to hang off, not a string that
 * two administrators could spell two different ways.
 *
 * Every stock item belongs to one, and the create path defaults to the seeded
 * `Non-perishable` row when none is supplied — see migration `0034`.
 *
 * `name` is unique in the schema, though Pete settled on 2026-09-05 (was Q51)
 * that the charity does not need this enforced — it happens to be true in
 * practice, and the existing 409-on-duplicate behaviour was left as it was
 * rather than relaxed. Do not read this constraint as a stated requirement.
 */
export const stockTakeGroupings = sqliteTable('stock_take_groupings', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * A shelf that holds several stock items in fixed proportions and is counted
 * as one line on the stock take rather than item by item.
 *
 * `shelfKey` is unique: a crate is the only thing on its shelf as far as the
 * grouped stock take is concerned, and a second crate claiming the same shelf
 * is refused rather than silently allowed to shadow the first.
 */
export const crates = sqliteTable(
  'crates',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    shelfKey: text('shelf_key').notNull().unique(),
    groupingId: text('grouping_id')
      .notNull()
      .references(() => stockTakeGroupings.id),
    sizePerCrate: integer('size_per_crate').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('crates_size_per_crate_positive', sql`${table.sizePerCrate} > 0`)],
);

/**
 * One stock item's share of a crate. Explicit rows, not derived from anything
 * else — changing a stock item's shelf number must never silently alter which
 * crate it belongs to or what share it holds.
 *
 * Two independent percentage tables, because a crate decomposes differently
 * depending on why it is being decomposed: `stockCompositionPercent` splits a
 * *counted* crate across its members for the ledger, `shoppingCompositionPercent`
 * splits a *shortfall* across them for the shopping list. Each totals exactly
 * 100 across a crate's members — enforced in the service, not in SQL, since a
 * `CHECK` here cannot sum across rows.
 */
export const crateMembers = sqliteTable(
  'crate_members',
  {
    crateId: text('crate_id')
      .notNull()
      .references(() => crates.id),
    stockItemId: text('stock_item_id')
      .notNull()
      .references(() => stockItems.id),
    stockCompositionPercent: integer('stock_composition_percent').notNull(),
    shoppingCompositionPercent: integer('shopping_composition_percent').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.crateId, table.stockItemId] }),
    // Every issue-detection and decomposition query starts from "which
    // crate(s) is this item a member of" — this is that lookup's index.
    index('idx_crate_members_stock_item').on(table.stockItemId),
    check(
      'crate_members_stock_percent_range',
      sql`${table.stockCompositionPercent} BETWEEN 0 AND 100`,
    ),
    check(
      'crate_members_shopping_percent_range',
      sql`${table.shoppingCompositionPercent} BETWEEN 0 AND 100`,
    ),
  ],
);

export const cratesRelations = relations(crates, ({ many, one }) => ({
  members: many(crateMembers),
  grouping: one(stockTakeGroupings, {
    fields: [crates.groupingId],
    references: [stockTakeGroupings.id],
  }),
}));

export const crateMembersRelations = relations(crateMembers, ({ one }) => ({
  crate: one(crates, { fields: [crateMembers.crateId], references: [crates.id] }),
  stockItem: one(stockItems, { fields: [crateMembers.stockItemId], references: [stockItems.id] }),
}));

export type StockTakeGrouping = typeof stockTakeGroupings.$inferSelect;
export type NewStockTakeGrouping = typeof stockTakeGroupings.$inferInsert;
export type Crate = typeof crates.$inferSelect;
export type NewCrate = typeof crates.$inferInsert;
export type CrateMember = typeof crateMembers.$inferSelect;
export type NewCrateMember = typeof crateMembers.$inferInsert;
