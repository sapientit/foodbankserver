import { relations, sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { authorisedReferrers, referralReasons } from './referrers.ts';
import { sessions } from './sessions.ts';
import { users } from './users.ts';

/**
 * `pending_review` is where a referral from an unrecognised address lands.
 *
 * An unauthorised referrer is no longer refused: the referral is taken and an
 * administrator accepts or rejects it. That is a queue of people waiting to be
 * fed rather than a door closed on them, and it is the charity's decision —
 * see `INITIAL_SPEC1.txt`, "Referral".
 */
export const REFERRAL_STATUSES = ['pending_review', 'active', 'rejected', 'cancelled'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/**
 * The two statuses that occupy a place on a session.
 *
 * A referral awaiting review holds its place, so a session fills with everyone
 * who might come rather than only those already looked at. Rejecting one gives
 * the place back. The alternative — counting only accepted referrals — lets an
 * administrator working through a queue on the morning of a session push it
 * past capacity, and the person who finds out is the team lead in the hall.
 */
export const REFERRAL_STATUSES_HOLDING_A_PLACE = ['pending_review', 'active'] as const;

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
 * `adults`, `children`, `isDelivery`, `needsFuelHelp` and `reasonId` sit
 * **outside** the purged set on purpose. Once the referee's own columns are
 * nulled they are no longer identifiable, so these become statistics rather
 * than personal data — and they are exactly what the charity needs to answer
 * "we fed 340 households, 890 people, 22% for benefit delay, in Q3".
 *
 * That is only safe because the reason is a **dropdown**, not free text.
 * Someone always eventually types a name into a free-text field.
 *
 * **The referrer's own details are kept too**, including `referrerName`,
 * `referrerEmail` and `referrerPhone`. The retention period exists to forget
 * the household that needed feeding, not the professional who referred them;
 * the charity needs to know who sent a referral long after the referral itself
 * has been anonymised. They stay nullable all the same, because they are
 * optional on some paths and because narrowing that later would need a rebuild.
 */
export const referrals = sqliteTable(
  'referrals',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    status: text('status').$type<ReferralStatus>().notNull().default('active'),
    referredAt: text('referred_at').notNull(),
    cancelledAt: text('cancelled_at'),
    cancelledReason: text('cancelled_reason'),

    /**
     * One line from the administrator who accepted or rejected this referral.
     *
     * Overwritten by a later review — there is no history, and no separate
     * review timestamp: the charity wanted the referrer's submission timed
     * (`referredAt`) and the review not. It is admin-only on the way out
     * because it can name a referrer or explain a suspicion.
     */
    reviewComment: text('review_comment'),
    /** Recorded for accountability. Never exposed; no screen asks who reviewed. */
    reviewedByUserId: text('reviewed_by_user_id').references(() => users.id),

    // --- Provenance. Organisation is retained; the individual is not. ---
    /**
     * As the referrer typed it, not as the authorised-referrer row says.
     *
     * An unrecognised referrer has no row to derive it from — which is the
     * whole reason the form now asks. `authorisedReferrerId` is still written
     * from the server's own match, so a submitted string never decides which
     * organisation a referral is credited to.
     */
    referrerOrganisation: text('referrer_organisation').notNull(),
    authorisedReferrerId: text('authorised_referrer_id').references(() => authorisedReferrers.id),

    // --- Retained after a purge: statistics, once nobody is identifiable. ---
    adults: integer('adults').notNull(),
    children: integer('children').notNull(),
    /**
     * Delivered rather than collected. There is no second address: a delivery
     * goes to the referee's own address, so `refereeAddress` is the one the
     * driver uses.
     */
    isDelivery: integer('is_delivery').notNull().default(0),
    reasonId: text('reason_id')
      .notNull()
      .references(() => referralReasons.id),
    /**
     * A column rather than a dynamic answer because it is reported on.
     *
     * The two questions that follow from it — pre-payment meter, permission to
     * ring about fuel — are ordinary answers and stay in `answersJson`.
     */
    needsFuelHelp: integer('needs_fuel_help').notNull().default(0),

    /**
     * The referrer, who is a professional acting in their job. Kept after a
     * purge; see the note on this table. Nullable for the reason every other
     * personal column here is.
     */
    referrerName: text('referrer_name'),
    referrerEmail: text('referrer_email'),
    referrerPhone: text('referrer_phone'),

    // ===================== PII BLOCK =====================
    // The referee's own details. Every column below is nullable so a purge can
    // null it in place, and every one of them is nulled by `purgeReferralPii`.
    // Required-ness is enforced in Zod. Do not add NOT NULL here.
    //
    // The name is stored in two parts because the surname is what a list sorts
    // by and what a volunteer matches a bag to; joining them into one string
    // makes the split cosmetic and unrecoverable.
    refereeFirstName: text('referee_first_name'),
    refereeSurname: text('referee_surname'),
    /** `YYYY-MM-DD`. A date, not an age — an age is wrong a year later. */
    refereeDateOfBirth: text('referee_date_of_birth'),
    refereeAddress: text('referee_address'),
    refereePostcode: text('referee_postcode'),
    refereePhone: text('referee_phone'),
    /**
     * Dynamic answers, stored exactly as the client sent them.
     *
     * The referral form is client configuration, so the server holds no
     * definition to interpret these against and does not try to. The blob is
     * self-describing — a key and the answer given — which is what keeps a
     * referral captured under an older form readable.
     */
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
    check(
      'referrals_status_valid',
      sql`${table.status} IN ('pending_review', 'active', 'rejected', 'cancelled')`,
    ),
    check('referrals_adults_valid', sql`${table.adults} >= 0`),
    check('referrals_children_valid', sql`${table.children} >= 0`),
    check('referrals_household_not_empty', sql`${table.adults} + ${table.children} > 0`),
    check('referrals_is_delivery_boolean', sql`${table.isDelivery} IN (0, 1)`),
    check('referrals_needs_fuel_help_boolean', sql`${table.needsFuelHelp} IN (0, 1)`),
  ],
);

/**
 * `referral_key` survives here although nothing issues one any more.
 *
 * The fifteen-minute self-service window is gone — a referrer confirms and
 * then phones if they need a change — but audit rows written while it existed
 * still carry this actor kind, and the `CHECK` that admits it is on a table
 * whose constraints cannot be dropped without a rebuild. Removing the value
 * would fail reading history, for nothing.
 */
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

export const referralsRelations = relations(referrals, ({ one }) => ({
  session: one(sessions, { fields: [referrals.sessionId], references: [sessions.id] }),
  reason: one(referralReasons, { fields: [referrals.reasonId], references: [referralReasons.id] }),
}));

export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
