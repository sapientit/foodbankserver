import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { referrals } from './referrals.ts';
import { sessions } from './sessions.ts';
import { users } from './users.ts';

/**
 * One column carries what a message is, rather than a direction plus a type.
 *
 * Direction is derivable from the kind, and two columns saying overlapping
 * things is two columns that can disagree. This is a `CHECK` constraint, and
 * a new value costs a table rebuild, which is how `stock_ledger.movement_type`
 * came to be rebuilt three times — `referrer_reply` below is the second time
 * this table has paid it. Unlike `referrals`, nothing holds a foreign key
 * *to* `sms_messages`, so the rebuild carries none of `migrations/0008`'s
 * deferred-FK-counter complications; it is a plain drizzle-kit recreate.
 *
 * - `reminder` — what the food bank sent about a session.
 * - `staff_reply` — a person answering the household from the session screen.
 * - `household_reply` — what the household texted back.
 * - `referrer_reply` — an inbound text from a phone number that is currently
 *   a referrer collecting one or more open `referrer_collect` parcels.
 *   **Never carries a `referralId`** — see the column comment — because it is
 *   a set of candidate households, not one, and is never a match for it to
 *   have made. Admin-only; see `sms.service.ts` and `sms.routes.ts`.
 * - `failure` — the reminder did not go: no number held, a number that is not
 *   a mobile, or the provider refused it. Not a message anybody sent, but it
 *   belongs on the household's line where somebody will see it.
 */
export const SMS_MESSAGE_KINDS = [
  'reminder',
  'staff_reply',
  'household_reply',
  'referrer_reply',
  'failure',
] as const;
export type SmsMessageKind = (typeof SMS_MESSAGE_KINDS)[number];

/** The kinds that count towards the numbers on the run-session screen. */
export const SMS_INBOUND_KINDS = ['household_reply', 'failure'] as const;

/**
 * Whose phone number `phone` actually is, on this one message — not who
 * `referralId` belongs to, which is a different question `referrer_reply`
 * makes visible: that column can be a referee's own referral while this one
 * says the number reached was the referrer's.
 *
 * Audit information only, alongside `phone` itself: `INITIAL_SPEC1.txt`,
 * "SMS reminders and replies" now sends a `referrer_collect` referral's
 * messages to the referrer rather than the referee, and this is what records
 * which one actually happened for a given row, without a reader having to
 * cross-reference the referral's current `collectionMethod` — which can
 * itself be corrected later — to work it out.
 */
export const SMS_RECIPIENT_ROLES = ['referee', 'referrer'] as const;
export type SmsRecipientRole = (typeof SMS_RECIPIENT_ROLES)[number];

/**
 * Text messages to and from households, and the failures to send them.
 *
 * ## This is the most sensitive table in the system
 *
 * `body` is free text written by a household in crisis and `phone` is how to
 * reach them. Neither may be logged, put in an error message, or returned to a
 * caller the mapper has not allowed. See `docs/engineering/personal-data.md`.
 *
 * ## Rows live thirty days
 *
 * `purge-sms.ts` deletes on `occurredAt` nightly, and **deletes rather than
 * nulls**: the message is the personal data, and unlike a referral there is no
 * statistic underneath worth keeping. That is the charity's decision — see
 * `INITIAL_SPEC1.txt`, "SMS reminders and replies".
 *
 * ## A null `referralId` is a loose reply — or a referrer message
 *
 * Somebody texted a number the food bank holds no upcoming referral for. The
 * row is still written — a reply is never dropped — and only administrators
 * see it. The thirty days apply to these too, which is the only thing stopping
 * them accumulating with no referral to count a period from.
 *
 * A `referrer_reply` row is also always null here, for a different reason: a
 * referrer can be collecting for more than one open `referrer_collect`
 * referral, so there is no single one to snapshot. `sms.service.ts` looks up
 * that referrer's currently open candidates fresh whenever an administrator
 * reads the row, rather than fixing a set at insert time that would go stale
 * the moment one of those referrals closed.
 *
 * ## `sessionId` is a snapshot, not a lookup
 *
 * It is stamped once, at insert, from `referral.sessionId` as it stood at
 * that moment — never re-derived later. `referrals.sessionId` is a mutable
 * column that `referrals.service.ts`'s `move()` overwrites in place, so a
 * message's own session would silently drift to wherever the household ends
 * up if this were computed by joining through the referral instead. Null
 * means the same as a null `referralId`: no session was known when the row
 * was written, which the administrator inbox treats as a loose reply.
 */
export const smsMessages = sqliteTable(
  'sms_messages',
  {
    id: text('id').primaryKey(),
    referralId: text('referral_id').references(() => referrals.id),
    /** Snapshot at insert time — see the note above. Null on a loose reply. */
    sessionId: text('session_id').references(() => sessions.id),
    kind: text('kind').$type<SmsMessageKind>().notNull(),
    /** E.164 where known. Personal data; see the note on this table. */
    phone: text('phone').notNull(),
    /** Personal data. For a `failure` this is the reason, not a message. */
    body: text('body').notNull(),
    /**
     * The provider's own id, and **the webhook's idempotency guard**.
     *
     * TheSMSWorks retries a webhook it did not get a `200` for, so the same
     * reply can arrive twice. The unique index below is what makes the second
     * one a no-op instead of a duplicate on somebody's screen. Null for rows
     * the provider was never involved in — a failure with no number to send to.
     */
    providerMessageId: text('provider_message_id'),
    occurredAt: text('occurred_at').notNull(),
    /** Null means unread. Outbound rows and failures are read on arrival. */
    readAt: text('read_at'),
    /** Who sent a `staff_reply`, or who pressed the button for a `reminder`. */
    sentByUserId: text('sent_by_user_id').references(() => users.id),
    /**
     * Whose number `phone` is — see `SmsRecipientRole`. Null on a genuinely
     * loose reply, where nothing is known to derive it from.
     */
    recipientRole: text('recipient_role').$type<SmsRecipientRole | null>(),
    /**
     * True when this row was never actually sent through TheSMSWorks —
     * `SMS_SIMULATE`'s dev/test simulator, or a destination outside
     * `SMS_LIVE_NUMBERS` in a restricted test environment. Only meaningful on
     * `reminder` and `staff_reply`; a `household_reply` has no simulated
     * form, and a `failure` already says nothing was sent. Always false in
     * production, where both settings are refused at boot — see
     * `config/env.ts`.
     */
    simulated: integer('simulated', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_sms_messages_referral').on(table.referralId, table.occurredAt),
    /** The purge scans this, nightly, on the whole table. */
    index('idx_sms_messages_occurred').on(table.occurredAt),
    /**
     * The administrator inbox's "does this number have anything besides a
     * reminder" check, and its final scan once a number qualifies — both key
     * off `phone` within the retention window. See `sms.repository.ts`,
     * `listInbox`.
     */
    index('idx_sms_messages_phone').on(table.phone, table.occurredAt),
    /** The administrator inbox joins on this to classify a message's location. */
    index('idx_sms_messages_session').on(table.sessionId),
    /**
     * SQLite treats NULLs as distinct, so rows without a provider id never
     * collide with each other. Match it with
     * `isUniqueViolation(error, 'sms_messages.provider_message_id')` — naming
     * the column, not the index, because SQLite reports columns.
     */
    uniqueIndex('idx_sms_messages_provider').on(table.providerMessageId),
    check(
      'sms_messages_kind_valid',
      sql`${table.kind} IN ('reminder', 'staff_reply', 'household_reply', 'referrer_reply', 'failure')`,
    ),
    check(
      'sms_messages_recipient_role_valid',
      sql`${table.recipientRole} IS NULL OR ${table.recipientRole} IN ('referee', 'referrer')`,
    ),
  ],
);

export type SmsMessage = typeof smsMessages.$inferSelect;
export type NewSmsMessage = typeof smsMessages.$inferInsert;
