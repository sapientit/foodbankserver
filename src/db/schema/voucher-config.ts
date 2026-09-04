import { sql } from 'drizzle-orm';
import { check, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** The single row id. Enforced by a CHECK so a second range cannot exist. */
export const VOUCHER_CONFIG_ID = 'current';

/**
 * The one Christmas-voucher date range an administrator maintains on the
 * Master Data screen — `INITIAL_SPEC1.txt`, `#Christmas voucher and
 * first-time selection`.
 *
 * One row, the same singleton pattern `parcel_grid` uses: the range is
 * maintained as a whole, so there is one write rather than two for what is
 * conceptually a single edit. `startDate`/`endDate` are `YYYY-MM-DD`,
 * inclusive at both ends — a session dated on either boundary is in range.
 *
 * Nothing references this table, so unlike `referrals.first_time_review_*`
 * it costs nothing to give it a real `CHECK`.
 */
export const voucherConfig = sqliteTable(
  'voucher_config',
  {
    id: text('id').primaryKey(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('voucher_config_singleton', sql`${table.id} = 'current'`),
    check('voucher_config_date_order', sql`${table.endDate} >= ${table.startDate}`),
  ],
);

export type VoucherConfigRow = typeof voucherConfig.$inferSelect;
export type NewVoucherConfigRow = typeof voucherConfig.$inferInsert;
