import { relations, sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { referrals } from './referrals.ts';
import { sessions } from './sessions.ts';
import { stockItems } from './stock.ts';
import { users } from './users.ts';

export const PICK_LIST_STATUSES = ['draft', 'printed', 'confirmed'] as const;
export type PickListStatus = (typeof PICK_LIST_STATUSES)[number];

export const ATTENDANCE_STATUSES = ['pending', 'attended', 'no_show', 'cancelled'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const PARCEL_LINE_SOURCES = ['model', 'manual'] as const;
export type ParcelLineSource = (typeof PARCEL_LINE_SOURCES)[number];

/**
 * One pick list per session, generated on first view.
 *
 * `confirmed` means **picking is finished and the list is locked** — it does
 * *not* move stock. Stock moves on attendance, which is a separate step.
 *
 * The contents are **copied** from the model parcels at generation, not looked
 * up at print time. That copy is what makes a pick list immutable in practice:
 * editing a model parcel afterwards cannot change a list that already exists,
 * and a picker's sheet never changes under them.
 */
export const pickLists = sqliteTable(
  'pick_lists',
  {
    id: text('id').primaryKey(),
    /** Unique: generating twice for one session is a bug, not a feature. */
    sessionId: text('session_id')
      .notNull()
      .unique()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    status: text('status').$type<PickListStatus>().notNull().default('draft'),
    generatedAt: text('generated_at').notNull(),
    generatedByUserId: text('generated_by_user_id').references(() => users.id),
    firstPrintedAt: text('first_printed_at'),
    confirmedAt: text('confirmed_at'),
    confirmedByUserId: text('confirmed_by_user_id').references(() => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('pick_lists_status_valid', sql`${table.status} IN ('draft', 'printed', 'confirmed')`),
  ],
);

/**
 * One household's parcel within a pick list.
 *
 * `adults` and `children` are **snapshots taken at generation**. Amending a
 * referral afterwards must not silently change what a picker is holding, so
 * the divergence is reported instead and an admin decides whether to act.
 *
 * `pickNumber` is the human-facing number printed on the sheet, 1..N within
 * the session — short enough to read out over the noise of a hall.
 */
export const parcels = sqliteTable(
  'parcels',
  {
    id: text('id').primaryKey(),
    pickListId: text('pick_list_id')
      .notNull()
      .references(() => pickLists.id, { onDelete: 'cascade' }),
    referralId: text('referral_id')
      .notNull()
      .references(() => referrals.id),
    pickNumber: integer('pick_number').notNull(),
    adults: integer('adults').notNull(),
    children: integer('children').notNull(),
    reviewedAt: text('reviewed_at'),
    attendance: text('attendance').$type<AttendanceStatus>().notNull().default('pending'),
    attendanceRecordedAt: text('attendance_recorded_at'),
    attendanceRecordedByUserId: text('attendance_recorded_by_user_id').references(() => users.id),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    unique('idx_parcels_referral').on(table.pickListId, table.referralId),
    unique('idx_parcels_number').on(table.pickListId, table.pickNumber),
    index('idx_parcels_referral_lookup').on(table.referralId),
    check(
      'parcels_attendance_valid',
      sql`${table.attendance} IN ('pending', 'attended', 'no_show', 'cancelled')`,
    ),
    check('parcels_adults_valid', sql`${table.adults} >= 0`),
    check('parcels_children_valid', sql`${table.children} >= 0`),
  ],
);

/**
 * What actually goes in a parcel.
 *
 * Materialised at generation rather than resolved from the rules at print
 * time: the contents are then fixed regardless of what happens to the rules
 * afterwards, and a picker's sheet cannot change under them mid-session.
 *
 * `source` distinguishes what came from the model parcel from what a human
 * added or adjusted — the difference matters when a coordinator asks why a
 * parcel is not what the grid says it should be.
 */
export const parcelLines = sqliteTable(
  'parcel_lines',
  {
    id: text('id').primaryKey(),
    parcelId: text('parcel_id')
      .notNull()
      .references(() => parcels.id, { onDelete: 'cascade' }),
    stockItemId: text('stock_item_id')
      .notNull()
      .references(() => stockItems.id),
    quantity: integer('quantity').notNull(),
    source: text('source').$type<ParcelLineSource>().notNull().default('model'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    /** Adding an item already present bumps its quantity rather than duplicating. */
    unique('idx_parcel_lines_item').on(table.parcelId, table.stockItemId),
    check('parcel_lines_quantity_positive', sql`${table.quantity} > 0`),
    check('parcel_lines_source_valid', sql`${table.source} IN ('model', 'manual')`),
  ],
);

export const pickListsRelations = relations(pickLists, ({ many, one }) => ({
  parcels: many(parcels),
  session: one(sessions, { fields: [pickLists.sessionId], references: [sessions.id] }),
}));

export const parcelsRelations = relations(parcels, ({ many, one }) => ({
  lines: many(parcelLines),
  pickList: one(pickLists, { fields: [parcels.pickListId], references: [pickLists.id] }),
  referral: one(referrals, { fields: [parcels.referralId], references: [referrals.id] }),
}));

export const parcelLinesRelations = relations(parcelLines, ({ one }) => ({
  parcel: one(parcels, { fields: [parcelLines.parcelId], references: [parcels.id] }),
  stockItem: one(stockItems, { fields: [parcelLines.stockItemId], references: [stockItems.id] }),
}));

export type PickList = typeof pickLists.$inferSelect;
export type NewPickList = typeof pickLists.$inferInsert;
export type Parcel = typeof parcels.$inferSelect;
export type NewParcel = typeof parcels.$inferInsert;
export type ParcelLine = typeof parcelLines.$inferSelect;
export type NewParcelLine = typeof parcelLines.$inferInsert;
