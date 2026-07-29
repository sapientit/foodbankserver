import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const REFERRER_MATCH_TYPES = ['email', 'domain'] as const;
export type ReferrerMatchType = (typeof REFERRER_MATCH_TYPES)[number];

/**
 * Who may refer someone to the food bank.
 *
 * Authorisation is by exact email address or by domain — the spec's
 * `*@guildford.gov.uk`. The `*@` is UI sugar; the bare domain is stored.
 *
 * There is deliberately **no proof of identity**: the spec asks only that the
 * address is well formed. So this table is an allowlist of organisations, not
 * an authentication mechanism, and nothing downstream may treat it as one.
 *
 * An exact-email row beats a domain row, which makes an inactive email row a
 * way to block one individual inside an otherwise authorised organisation.
 */
export const authorisedReferrers = sqliteTable(
  'authorised_referrers',
  {
    id: text('id').primaryKey(),
    matchType: text('match_type').$type<ReferrerMatchType>().notNull(),
    /** Lowercased: `jane@guildford.gov.uk` or `guildford.gov.uk`. */
    matchValue: text('match_value').notNull(),
    organisationName: text('organisation_name').notNull(),
    isActive: integer('is_active').notNull().default(1),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    unique('idx_authorised_referrers_match').on(table.matchType, table.matchValue),
    check('authorised_referrers_match_type_valid', sql`${table.matchType} IN ('email', 'domain')`),
    check('authorised_referrers_is_active_boolean', sql`${table.isActive} IN (0, 1)`),
  ],
);

/**
 * The reason-for-referral dropdown.
 *
 * A closed list rather than free text, so it can be reported on with a GROUP
 * BY — and so nobody types a name into it. That second property is what lets
 * the reason be **retained after a PII purge**: once the referee is no longer
 * identifiable, a reason code is a statistic rather than personal data.
 *
 * `isActive` retires an option without breaking historical referrals that used
 * it. Never delete a row that a referral points at.
 */
export const referralReasons = sqliteTable(
  'referral_reasons',
  {
    id: text('id').primaryKey(),
    /** Stable machine key, e.g. `benefit_delay`. Never reused, never renamed. */
    code: text('code').notNull().unique(),
    label: text('label').notNull(),
    displayOrder: integer('display_order').notNull().default(0),
    isActive: integer('is_active').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('referral_reasons_is_active_boolean', sql`${table.isActive} IN (0, 1)`)],
);

export type AuthorisedReferrer = typeof authorisedReferrers.$inferSelect;
export type NewAuthorisedReferrer = typeof authorisedReferrers.$inferInsert;
export type ReferralReason = typeof referralReasons.$inferSelect;
export type NewReferralReason = typeof referralReasons.$inferInsert;
