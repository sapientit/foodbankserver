import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  smsMessages,
  SMS_INBOUND_KINDS,
  type NewSmsMessage,
  type SmsMessage,
} from '../../db/schema/sms.ts';
import {
  referrals,
  REFERRAL_STATUSES_HOLDING_A_PLACE,
  type Referral,
} from '../../db/schema/referrals.ts';
import { sessions, type Session } from '../../db/schema/sessions.ts';

/**
 * `sms_messages` queries, plus the one statement outside that table this
 * module has to write: the conditional flag on `referrals`.
 *
 * **Two other tables are read directly here** — `referrals` and `sessions` —
 * the same way `sessions.repository.ts` already reads `referrals` to count a
 * session's bookings. Both are read-only joins needed to find who to remind
 * and who a reply belongs to; nothing here writes to either table except the
 * one conditional `UPDATE` the send flow needs in the same batch as its
 * message inserts, which is exactly the shape `updateIfStatus` uses elsewhere
 * for a D1 database with no interactive transactions.
 */
export function createSmsRepository(db: Database) {
  return {
    async findById(id: string): Promise<SmsMessage | undefined> {
      const rows = await db.select().from(smsMessages).where(eq(smsMessages.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    /** The whole conversation for one referral, oldest first, both directions. */
    async threadForReferral(referralId: string): Promise<SmsMessage[]> {
      return db
        .select()
        .from(smsMessages)
        .where(eq(smsMessages.referralId, referralId))
        .orderBy(asc(smsMessages.occurredAt));
    },

    /**
     * Inbound counts per referral — **`household_reply` and `failure` only**.
     * A count that rose when staff answered would be counting their own work
     * back at them, so `reminder` and `staff_reply` never contribute here.
     *
     * One query for however many referrals a session holds, grouped rather
     * than queried per household.
     */
    async inboundCountsFor(
      referralIds: readonly string[],
    ): Promise<Map<string, { messageCount: number; unreadCount: number }>> {
      const counts = new Map<string, { messageCount: number; unreadCount: number }>();
      if (referralIds.length === 0) return counts;

      const rows = await db
        .select({
          referralId: smsMessages.referralId,
          messageCount: sql<number>`COUNT(*)`,
          unreadCount: sql<number>`SUM(CASE WHEN ${smsMessages.readAt} IS NULL THEN 1 ELSE 0 END)`,
        })
        .from(smsMessages)
        .where(
          and(
            inArray(smsMessages.referralId, [...referralIds]),
            inArray(smsMessages.kind, [...SMS_INBOUND_KINDS]),
          ),
        )
        .groupBy(smsMessages.referralId);

      for (const row of rows) {
        if (row.referralId === null) continue;
        counts.set(row.referralId, {
          messageCount: row.messageCount,
          unreadCount: row.unreadCount,
        });
      }
      return counts;
    },

    /** Loose replies — no referral — oldest first, for the admin-only screen. */
    async listUnmatched(): Promise<SmsMessage[]> {
      return db
        .select()
        .from(smsMessages)
        .where(isNull(smsMessages.referralId))
        .orderBy(asc(smsMessages.occurredAt));
    },

    /**
     * Marks every unread inbound row for a referral as read, in one
     * statement. Safe to run whether or not anything is actually unread —
     * opening an already-read thread is a no-op, not an error.
     */
    async markThreadRead(referralId: string, at: string): Promise<void> {
      await db
        .update(smsMessages)
        .set({ readAt: at, updatedAt: at })
        .where(and(eq(smsMessages.referralId, referralId), isNull(smsMessages.readAt)));
    },

    /** Marks one loose reply as read. A no-op if it already was. */
    async markOneRead(id: string, at: string): Promise<SmsMessage | undefined> {
      const rows = await db
        .update(smsMessages)
        .set({ readAt: at, updatedAt: at })
        .where(and(eq(smsMessages.id, id), isNull(smsMessages.readAt)))
        .returning();
      const updated = expectAtMostOne(rows);
      if (updated !== undefined) return updated;

      // Already read (or absent): report current state rather than nothing.
      const existing = await db.select().from(smsMessages).where(eq(smsMessages.id, id)).limit(1);
      return expectAtMostOne(existing);
    },

    async insert(value: NewSmsMessage): Promise<SmsMessage> {
      const rows = await db.insert(smsMessages).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert sms message');
      return inserted;
    },

    /**
     * Every referral holding a place on a session that has not happened yet,
     * soonest first, for matching an inbound reply by phone number. Phone
     * comparison happens in memory (`phone.ts` normalises formats SQL cannot
     * usefully compare), so this hands back full rows rather than filtering
     * by number.
     */
    async referralsOnUpcomingSessions(
      nowUtc: string,
    ): Promise<{ referral: Referral; session: Session }[]> {
      return db
        .select({ referral: referrals, session: sessions })
        .from(referrals)
        .innerJoin(sessions, eq(referrals.sessionId, sessions.id))
        .where(
          and(
            gte(sessions.startsAtUtc, nowUtc),
            inArray(referrals.status, [...REFERRAL_STATUSES_HOLDING_A_PLACE]),
          ),
        )
        .orderBy(asc(sessions.startsAtUtc));
    },

    /** Every household holding a place on a session, for the summary screen. */
    async referralsHoldingAPlace(sessionId: string): Promise<Referral[]> {
      return db
        .select()
        .from(referrals)
        .where(
          and(
            eq(referrals.sessionId, sessionId),
            inArray(referrals.status, [...REFERRAL_STATUSES_HOLDING_A_PLACE]),
          ),
        );
    },

    async findReferralById(id: string): Promise<Referral | undefined> {
      const rows = await db.select().from(referrals).where(eq(referrals.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    // ---- Statement builders. Compose these, then run ONE db.batch(). ----

    buildInsertMessage(value: NewSmsMessage) {
      return db.insert(smsMessages).values(value);
    },

    /**
     * `UPDATE referrals SET sms_reminder_sent_at = ? WHERE id = ? AND
     * sms_reminder_sent_at IS NULL` — the condition travels with the write,
     * not a read first, for the usual D1 reason: two team leads pressing the
     * button at once must not send the same household two reminders, and
     * there is no transaction to make "check then write" safe. Runs in the
     * same batch as the message row it belongs to, so a reminder is never
     * recorded as sent without the row that says what was sent.
     */
    buildMarkReminderSent(referralId: string, at: string) {
      return db
        .update(referrals)
        .set({ smsReminderSentAt: at, updatedAt: at })
        .where(and(eq(referrals.id, referralId), isNull(referrals.smsReminderSentAt)));
    },
  };
}

export type SmsRepository = ReturnType<typeof createSmsRepository>;
