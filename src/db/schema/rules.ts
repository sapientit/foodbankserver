import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** The grid covers 1-5 adults and 0-5 children. Larger households clamp in. */
export const MIN_GRID_ADULTS = 1;
export const MAX_GRID_ADULTS = 5;
export const MIN_GRID_CHILDREN = 0;
export const MAX_GRID_CHILDREN = 5;
export const GRID_CELL_COUNT =
  (MAX_GRID_ADULTS - MIN_GRID_ADULTS + 1) * (MAX_GRID_CHILDREN - MIN_GRID_CHILDREN + 1);

/**
 * A named model parcel: "Single parcel", "Family parcel", "Large family".
 *
 * The name is the key the grid references, so several household sizes can
 * share one parcel and adjusting that parcel updates every cell pointing at
 * it. That indirection is the point — without it, changing the family parcel
 * would mean editing the same quantities in a dozen grid cells.
 *
 * **These are not versioned.** When a pick list is generated the contents are
 * *copied* into `parcel_lines`, so a parcel already picked is unaffected by any
 * later edit. Copying is the whole guarantee; a version history on top of it
 * would be ceremony that protects nothing.
 *
 * Contents are JSON because a model parcel is always read and written whole.
 */
export const modelParcels = sqliteTable(
  'model_parcels',
  {
    id: text('id').primaryKey(),
    /** The key the grid uses. Unique, and never reused for a different parcel. */
    name: text('name').notNull().unique(),
    description: text('description'),
    /** `[{ "stockItemId": "…", "quantity": 2 }, …]` */
    contentsJson: text('contents_json').notNull(),
    displayOrder: integer('display_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_model_parcels_order').on(table.displayOrder)],
);

/** The single row id. Enforced by a CHECK so a second grid cannot exist. */
export const PARCEL_GRID_ID = 'current';

/**
 * The household grid: thirty cells, each naming a model parcel.
 *
 * One row, enforced by the primary key plus a CHECK. The grid is maintained as
 * a whole — a coordinator fills in the cells and saves once — so splitting it
 * across thirty rows would mean thirty writes for one conceptual edit on a
 * database with no transactions.
 */
export const parcelGrid = sqliteTable(
  'parcel_grid',
  {
    id: text('id').primaryKey(),
    /** `{ "1-0": "Single parcel", "2-3": "Family parcel", … }` */
    gridJson: text('grid_json').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('parcel_grid_singleton', sql`${table.id} = 'current'`)],
);

export type ModelParcel = typeof modelParcels.$inferSelect;
export type NewModelParcel = typeof modelParcels.$inferInsert;
export type ParcelGridRow = typeof parcelGrid.$inferSelect;
