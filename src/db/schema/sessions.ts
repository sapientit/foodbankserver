import { relations, sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { users } from './users.ts';

/**
 * Enumerated generously — `in_progress` is unused in v1, but SQLite cannot
 * extend a CHECK constraint without rebuilding the table.
 */
export const SESSION_STATUSES = ['planned', 'in_progress', 'confirmed', 'cancelled'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * The template a weekly session is generated from.
 *
 * `startTime` is **Europe/London wall clock**, not an instant. That is the
 * whole point: a Tuesday 10:00 session stays at 10:00 through the BST
 * changeover. The instant is derived per occurrence, at materialisation.
 */
export const recurringSessions = sqliteTable(
  'recurring_sessions',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** ISO-8601 weekday: 1 = Monday … 7 = Sunday. */
    weekday: integer('weekday').notNull(),
    startTime: text('start_time').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    location: text('location').notNull(),
    capacity: integer('capacity').notNull().default(25),
    /**
     * `HH:MM` London wall clock, or null for "the same as `startTime`".
     *
     * The van does not go out when the hall opens, so a household expecting a
     * delivery is told a different time from one collecting. It is a time to
     * read out and nothing else — nothing is scheduled or routed from it, which
     * is why there is no derived instant beside it as there is for `startTime`.
     */
    deliveryTime: text('delivery_time'),
    /**
     * Whether this session takes deliveries at all.
     *
     * **No `CHECK (0, 1)`, unlike every other boolean here**, and deliberately.
     * SQLite cannot add a table-level constraint to an existing table, so the
     * convention would have cost a rebuild of this table and `sessions` — both
     * foreign-key parents — to gain a constraint Zod already enforces at the
     * only place a value enters. Left off the Drizzle schema too, so this file
     * and the database agree and `db:generate` does not propose that rebuild.
     */
    deliveriesAllowed: integer('deliveries_allowed').notNull().default(1),
    /** `YYYY-MM-DD`. */
    activeFrom: text('active_from').notNull(),
    /** `YYYY-MM-DD`, or null for open-ended. */
    activeUntil: text('active_until'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('recurring_sessions_weekday_valid', sql`${table.weekday} BETWEEN 1 AND 7`),
    check('recurring_sessions_duration_positive', sql`${table.durationMinutes} > 0`),
    check('recurring_sessions_capacity_valid', sql`${table.capacity} >= 0`),
  ],
);

/**
 * A real, individually editable session.
 *
 * Materialised by the cron six weeks ahead rather than computed on read, so an
 * admin can re-time, re-locate or cancel one occurrence without the change
 * being recomputed away, and so referrals have a row to attach to.
 *
 * Capacity counts **households (referrals)**, not people.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    /** Null for an ad hoc session that no template produced. */
    recurringSessionId: text('recurring_session_id').references(() => recurringSessions.id, {
      onDelete: 'set null',
    }),
    /**
     * The template slot this row fills, `YYYY-MM-DD`. Stays fixed even if the
     * admin moves `sessionDate`, because it is the cron's idempotency key.
     */
    occurrenceDate: text('occurrence_date'),
    /** The date the session actually happens on, `YYYY-MM-DD` London. */
    sessionDate: text('session_date').notNull(),
    /** `HH:MM` London wall clock. */
    startTime: text('start_time').notNull(),
    /** Derived instant. What the public window filter compares and sorts on. */
    startsAtUtc: text('starts_at_utc').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    location: text('location').notNull(),
    capacity: integer('capacity').notNull(),
    /**
     * `HH:MM` London wall clock, or null for "the same as `startTime`". Copied
     * from the template at materialisation and overridable per occurrence.
     * See the note on `recurringSessions.deliveryTime`.
     */
    deliveryTime: text('delivery_time'),
    /** See the note on `recurringSessions.deliveriesAllowed` — no `CHECK`, deliberately. */
    deliveriesAllowed: integer('deliveries_allowed').notNull().default(1),
    status: text('status').$type<SessionStatus>().notNull().default('planned'),
    cancelledReason: text('cancelled_reason'),
    /**
     * Set the moment an admin changes anything about this occurrence. The cron
     * never updates existing rows, so this is not needed to protect edits —
     * it exists for a future "propagate template change to untouched future
     * occurrences" operation.
     */
    isCustomised: integer('is_customised').notNull().default(0),
    generatedAt: text('generated_at'),
    confirmedAt: text('confirmed_at'),
    confirmedByUserId: text('confirmed_by_user_id').references(() => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    /**
     * The cron's idempotency key. SQLite treats NULLs as distinct in a unique
     * index, so ad hoc sessions (recurringSessionId IS NULL) never collide
     * with each other.
     */
    unique('idx_sessions_occurrence').on(table.recurringSessionId, table.occurrenceDate),
    index('idx_sessions_starts_at').on(table.startsAtUtc),
    index('idx_sessions_status_date').on(table.status, table.sessionDate),
    check(
      'sessions_status_valid',
      sql`${table.status} IN ('planned', 'in_progress', 'confirmed', 'cancelled')`,
    ),
    check('sessions_duration_positive', sql`${table.durationMinutes} > 0`),
    check('sessions_capacity_valid', sql`${table.capacity} >= 0`),
    check('sessions_is_customised_boolean', sql`${table.isCustomised} IN (0, 1)`),
  ],
);

export const recurringSessionsRelations = relations(recurringSessions, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  recurringSession: one(recurringSessions, {
    fields: [sessions.recurringSessionId],
    references: [recurringSessions.id],
  }),
}));

export type RecurringSession = typeof recurringSessions.$inferSelect;
export type NewRecurringSession = typeof recurringSessions.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
