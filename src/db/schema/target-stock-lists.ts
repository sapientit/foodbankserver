import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * A named standing target stock list — "Standard week", "Christmas" — an
 * administrator maintains so a team leader can shop against it. See
 * `INITIAL_SPEC1.txt`, `#Target stock lists and shopping`.
 *
 * `linesJson` is read and written whole, like `model_parcels.contents_json`:
 * `[{ "stockItemId": "…", "name": "…", "targetQuantity": 3 }, …]`.
 *
 * **Deliberately not a child table with a foreign key to `stock_items`.**
 * Each line carries the stock item id and a *snapshot* of its name as they
 * stood when the line was saved, not a live reference. A stock item can be
 * renamed or retired without touching a list that mentions it — reconciling
 * a list against the current catalogue is the client's job when the list is
 * opened, not something write-time validation should get in the way of. See
 * Q46 in `OPEN-QUESTIONS.md`.
 */
export const targetStockLists = sqliteTable('target_stock_lists', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  linesJson: text('lines_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type TargetStockListRow = typeof targetStockLists.$inferSelect;
export type NewTargetStockListRow = typeof targetStockLists.$inferInsert;
