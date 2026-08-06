import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { referrals } from './referrals.ts';
import { users } from './users.ts';

/**
 * One column carries what a message is, rather than a direction plus a type.
 *
 * Direction is derivable from the kind, and two columns saying overlapping
 * things is two columns that can disagree. The four values are the ones
 * `INITIAL_SPEC1.txt` names and no more — this is a `CHECK` constraint, and a
 * fifth costs a table rebuild, which is how `stock_ledger.movement_type` came
 * to be rebuilt three times.
 *
 * - `reminder` — what the food bank sent about a session.
 * - `staff_reply` — a person answering the household from the session screen.
 * - `household_reply` — what the household texted back.
 * - `failure` — the reminder did not go: no number held, a number that is not
 *   a mobile, or the provider refused it. Not a message anybody sent, but it
 *   belongs on the household's line where somebody will see it.
 */
export const SMS_MESSAGE_KINDS = ['reminder', 'staff_reply', 'household_reply', 'failure'] as const;
export type SmsMessageKind = (typeof SMS_MESSAGE_KINDS)[number];

/** The kinds that count towards the numbers on the run-session screen. */
export const SMS_INBOUND_KINDS = ['household_reply', 'failure'] as const;

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
 * ## A null `referralId` is a loose reply
 *
 * Somebody texted a number the food bank holds no upcoming referral for. The
 * row is still written — a reply is never dropped — and only administrators
 * see it. The thirty days apply to these too, which is the only thing stopping
 * them accumulating with no referral to count a period from.
 */
export const smsMessages = sqliteTable(
  'sms_messages',
  {
    id: text('id').primaryKey(),
    referralId: text('referral_id').references(() => referrals.id),
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
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_sms_messages_referral').on(table.referralId, table.occurredAt),
    /** The purge scans this, nightly, on the whole table. */
    index('idx_sms_messages_occurred').on(table.occurredAt),
    /**
     * SQLite treats NULLs as distinct, so rows without a provider id never
     * collide with each other. Match it with
     * `isUniqueViolation(error, 'sms_messages.provider_message_id')` — naming
     * the column, not the index, because SQLite reports columns.
     */
    uniqueIndex('idx_sms_messages_provider').on(table.providerMessageId),
    check(
      'sms_messages_kind_valid',
      sql`${table.kind} IN ('reminder', 'staff_reply', 'household_reply', 'failure')`,
    ),
  ],
);

export type SmsMessage = typeof smsMessages.$inferSelect;
export type NewSmsMessage = typeof smsMessages.$inferInsert;
