import { relations, sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { formDefinitions } from './forms.ts';
import { authorisedReferrers, referralReasons } from './referrers.ts';
import { sessions } from './sessions.ts';
import { users } from './users.ts';

export const REFERRAL_STATUSES = ['active', 'cancelled'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/**
 * A request to feed a household at a session.
 *
 * ## The PII rule, and why it looks wrong
 *
 * Every column holding personal data is **nullable in SQL and required in
 * Zod**. That asymmetry is deliberate and must not be "tidied up": SQLite has
 * no `ALTER COLUMN`, so a `NOT NULL` personal-data column could never be
 * purged without rebuilding a live table. Requiredness lives in
 * `referrals.schema.ts`, which is the only place a referral is ever created.
 *
 * ## What survives a purge, and why
 *
 * `adults`, `children`, `isDelivery` and `reasonId` sit **outside** the PII
 * block on purpose. Once the identifying columns are nulled the referee is no
 * longer identifiable, so these become statistics rather than personal data —
 * and they are exactly what the charity needs to answer "we fed 340
 * households, 890 people, 22% for benefit delay, in Q3".
 *
 * That is only safe because the reason is a **dropdown**, not free text.
 * Someone always eventually types a name into a free-text field.
 *
 * `referrerOrganisation` is an organisation, not a person, so it is NOT NULL.
 * `referrerEmail` and `referrerPhone` identify individuals and are therefore
 * nullable like the rest.
 */
export const referrals = sqliteTable(
  'referrals',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    /** Which form version captured this, so old answers stay interpretable. */
    formDefinitionId: text('form_definition_id')
      .notNull()
      .references(() => formDefinitions.id),
    status: text('status').$type<ReferralStatus>().notNull().default('active'),
    referredAt: text('referred_at').notNull(),
    cancelledAt: text('cancelled_at'),
    cancelledReason: text('cancelled_reason'),

    // --- Provenance. Organisation is retained; the individual is not. ---
    referrerOrganisation: text('referrer_organisation').notNull(),
    authorisedReferrerId: text('authorised_referrer_id').references(() => authorisedReferrers.id),

    // --- Retained after a purge: statistics, once nobody is identifiable. ---
    adults: integer('adults').notNull(),
    children: integer('children').notNull(),
    isDelivery: integer('is_delivery').notNull().default(0),
    reasonId: text('reason_id')
      .notNull()
      .references(() => referralReasons.id),

    // ===================== PII BLOCK =====================
    // Every column below is nullable so it can be nulled in place by a purge.
    // Required-ness is enforced in Zod. Do not add NOT NULL here.
    referrerEmail: text('referrer_email'),
    referrerPhone: text('referrer_phone'),
    refereeName: text('referee_name'),
    refereeAddress: text('referee_address'),
    refereePostcode: text('referee_postcode'),
    refereePhone: text('referee_phone'),
    /** Only when the parcel goes somewhere other than the referee's address. */
    deliveryAddress: text('delivery_address'),
    /** Dynamic answers. May contain anything the form asks for. */
    answersJson: text('answers_json'),
    // =====================================================

    piiPurgedAt: text('pii_purged_at'),
    /** Null for a public submission; set when an admin enters one by phone. */
    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_referrals_session').on(table.sessionId, table.status),
    index('idx_referrals_referred_at').on(table.referredAt),
    check('referrals_status_valid', sql`${table.status} IN ('active', 'cancelled')`),
    check('referrals_adults_valid', sql`${table.adults} >= 0`),
    check('referrals_children_valid', sql`${table.children} >= 0`),
    check('referrals_household_not_empty', sql`${table.adults} + ${table.children} > 0`),
    check('referrals_is_delivery_boolean', sql`${table.isDelivery} IN (0, 1)`),
  ],
);

/**
 * The 15-minute self-service window.
 *
 * A referral is made without authentication, so the only thing proving the
 * submitter is the same person is a secret handed back once. Only its SHA-256
 * hash is stored, so a database dump yields nothing usable, and lookup is a
 * single index probe on the hash.
 */
export const referralEditKeys = sqliteTable(
  'referral_edit_keys',
  {
    id: text('id').primaryKey(),
    referralId: text('referral_id')
      .notNull()
      .references(() => referrals.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull().unique(),
    /** Epoch seconds. */
    issuedAt: integer('issued_at').notNull(),
    /** `issuedAt + 900`, absolute. An amend does not extend it. */
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
    useCount: integer('use_count').notNull().default(0),
  },
  (table) => [index('idx_referral_edit_keys_expires').on(table.expiresAt)],
);

export const AUDIT_ACTOR_KINDS = ['user', 'referral_key', 'system', 'anonymous'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/**
 * Who changed what, and when.
 *
 * `detailJson` records **which fields changed and nothing else** — never the
 * old or new values. Logging the diff is the obvious thing to reach for and
 * would turn this table into a second, un-purgeable copy of every referral,
 * defeating the whole PII design above.
 */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    occurredAt: text('occurred_at').notNull(),
    actorKind: text('actor_kind').$type<AuditActorKind>().notNull(),
    actorUserId: text('actor_user_id').references(() => users.id),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    /** JSON array of changed field NAMES. Never values. */
    detailJson: text('detail_json'),
  },
  (table) => [
    index('idx_audit_entity').on(table.entityType, table.entityId, table.occurredAt),
    check(
      'audit_events_actor_kind_valid',
      sql`${table.actorKind} IN ('user', 'referral_key', 'system', 'anonymous')`,
    ),
  ],
);

export const referralsRelations = relations(referrals, ({ one, many }) => ({
  session: one(sessions, { fields: [referrals.sessionId], references: [sessions.id] }),
  reason: one(referralReasons, { fields: [referrals.reasonId], references: [referralReasons.id] }),
  editKeys: many(referralEditKeys),
}));

export const referralEditKeysRelations = relations(referralEditKeys, ({ one }) => ({
  referral: one(referrals, { fields: [referralEditKeys.referralId], references: [referrals.id] }),
}));

export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;
export type ReferralEditKey = typeof referralEditKeys.$inferSelect;
export type NewReferralEditKey = typeof referralEditKeys.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
