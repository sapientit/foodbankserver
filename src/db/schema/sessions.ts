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
     * `HH:MM` London wall clock, both or neither. Null on both means "the
     * session's own hours" — `startTime` to `startTime` plus
     * `durationMinutes`.
     *
     * The van does not go out when the hall opens, so a household expecting a
     * delivery is told a different span from the one collecting. A single
     * moment was tried and dropped: a van round cannot promise to be at a
     * door at 13:00 sharp, only that it will be between two times, so the
     * charity tells households a window, not a moment. It is a window to
     * read out and nothing else — nothing is scheduled or routed from it,
     * which is why there is no derived instant beside it as there is for
     * `startTime`.
     *
     * No `CHECK` for "both or neither" or "end after start": SQLite cannot
     * add a table-level constraint to an existing table, and both of these
     * are foreign-key parents — see the note on `deliveriesAllowed` below.
     * Zod enforces both rules at the only place a value enters.
     */
    deliveryWindowStart: text('delivery_window_start'),
    deliveryWindowEnd: text('delivery_window_end'),
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
     * `HH:MM` London wall clock, both or neither. Copied from the template at
     * materialisation and overridable per occurrence. See the note on
     * `recurringSessions.deliveryWindowStart`.
     */
    deliveryWindowStart: text('delivery_window_start'),
    deliveryWindowEnd: text('delivery_window_end'),
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
    /**
     * Set once this session and every referral on it — including the
     * cancelled and rejected ones — has been written to the charity's Google
     * spreadsheet. `NULL` is the extract queue: "what has not gone yet" is a
     * `WHERE extracted_at IS NULL` query, not something inferred from a
     * cursor. That makes the marker order-independent by construction — a
     * row that commits late is still `NULL`, so the next batch picks it up.
     * Self-healing, not a bug to guard against.
     *
     * A timestamp cursor over `confirmedAt` was considered and rejected:
     * stamp order is not commit order on Workers, so a session stamped
     * microseconds before another but committed after it would land behind
     * a "confirmed before X" cursor and never be extracted — a completed
     * session silently missing from the spreadsheet. A marker on the row
     * cannot fail that way.
     *
     * **The server never writes to Google.** This is stamped only when the
     * administrator's browser reports that its Sheets write succeeded. See
     * `INITIAL_SPEC1.txt`, "Sending referrals to the spreadsheet".
     *
     * No personal data lives here — it is a fact about the session, not
     * about a household.
     */
    extractedAt: text('extracted_at'),

    // ---- The reservation, so two administrators cannot extract at once ----
    //
    // The browser takes one session at a time, and between being handed a
    // session's referrals and reporting the write done it holds a claim on
    // it. All three columns move together: they are set as one, and a row
    // with one of them set and the others null is a bug.
    //
    // **A claim is not cleared on completion.** `extractClaimId` stays put
    // beside `extractedAt` so that repeating a completion — the browser
    // retried, the response was lost — can be recognised as the same claim
    // finishing the same session, and answered successfully rather than with
    // a conflict. Retrying completion must be safe; it is the one call the
    // browser may repeat.
    /** Opaque id handed to the browser; it presents this to complete. */
    extractClaimId: text('extract_claim_id'),
    /**
     * Who holds it. Completion by anyone else is refused — a second
     * administrator working the queue must not be able to mark a session
     * extracted on the strength of the first one's write.
     */
    extractClaimedByUserId: text('extract_claimed_by_user_id').references(() => users.id),
    /**
     * When the claim lapses, after which the session is claimable again.
     *
     * This is what makes a closed laptop recoverable. The browser holds the
     * only Google credential and the only knowledge of whether the write
     * happened, so if it goes away mid-session nothing can finish the job —
     * without an expiry that session would be reserved forever and the queue
     * would stop at it. Completing an expired claim is refused rather than
     * quietly accepted: by then somebody else may hold it, and stamping on
     * their behalf would mark a session extracted that nobody wrote.
     */
    extractClaimExpiresAt: text('extract_claim_expires_at'),
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
    /**
     * The extract queue is the small unextracted tail of a table that only
     * grows, so a partial index keeps the scan proportional to the backlog
     * rather than to the whole table. See `stock.ts`'s
     * `idx_stock_ledger_parcel_movement` for the same technique.
     */
    index('idx_sessions_unextracted')
      .on(table.extractedAt)
      .where(sql`${table.extractedAt} IS NULL`),
    /** Completion looks a session up by the claim the browser presents. */
    index('idx_sessions_extract_claim').on(table.extractClaimId),
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
