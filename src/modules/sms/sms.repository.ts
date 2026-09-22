import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import { instantToLondonWallClock } from '../../core/time/london.ts';
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
import { sessions, type Session, type SessionStatus } from '../../db/schema/sessions.ts';

/** The two statuses `sms.mapper.ts` treats as "closed" — see its `SmsMessageLocation`. */
const CLOSED_SESSION_STATUSES: readonly SessionStatus[] = ['confirmed', 'cancelled'];

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
     * Unread household replies and referrer messages within retention, split
     * four ways: `referrerUnread` is every unread `referrer_reply` — kept
     * apart from a loose household reply, per the spec, because a referrer
     * message is never a household's own reply and is never treated as one.
     * Of the rest (`household_reply` only), `unmatchedUnread` is a loose
     * reply with no session snapshot at all, `activeSessionUnread` is one
     * still on a planned/in-progress session whose own date has not passed —
     * the team leader's business, kept separate so an administrator can see
     * it without it counting as their own job — and `closedSessionUnread` is
     * one whose session has since closed, confirmed or cancelled **or simply
     * dated in the past**, which is nobody else's job by then. `today` and
     * `isClosedSession`/`isActiveSession` below apply the identical rule
     * `sms.mapper.ts`'s `isSessionClosed` uses for the admin inbox's
     * `location` field — kept in sync by hand, since a query can't call it.
     */
    async countUnreadByLocation(
      cutoff: string,
      today: string,
    ): Promise<{
      activeSessionUnread: number;
      closedSessionUnread: number;
      unmatchedUnread: number;
      referrerUnread: number;
    }> {
      const isReferrer = eq(smsMessages.kind, 'referrer_reply');
      const isLooseHouseholdReply = and(
        isNull(smsMessages.sessionId),
        eq(smsMessages.kind, 'household_reply'),
      );
      const isClosedSession = and(
        isNotNull(smsMessages.sessionId),
        or(inArray(sessions.status, [...CLOSED_SESSION_STATUSES]), lt(sessions.sessionDate, today)),
      );
      const isActiveSession = and(
        isNotNull(smsMessages.sessionId),
        notInArray(sessions.status, [...CLOSED_SESSION_STATUSES]),
        gte(sessions.sessionDate, today),
      );
      const rows = await db
        .select({
          referrerUnread: sql<number>`SUM(CASE WHEN ${isReferrer} THEN 1 ELSE 0 END)`,
          unmatchedUnread: sql<number>`SUM(CASE WHEN ${isLooseHouseholdReply} THEN 1 ELSE 0 END)`,
          activeSessionUnread: sql<number>`SUM(CASE WHEN ${isActiveSession} THEN 1 ELSE 0 END)`,
          closedSessionUnread: sql<number>`SUM(CASE WHEN ${isClosedSession} THEN 1 ELSE 0 END)`,
        })
        .from(smsMessages)
        .leftJoin(sessions, eq(smsMessages.sessionId, sessions.id))
        .where(
          and(
            inArray(smsMessages.kind, ['household_reply', 'referrer_reply']),
            isNull(smsMessages.readAt),
            gte(smsMessages.occurredAt, cutoff),
          ),
        );
      const row = rows[0];
      return {
        activeSessionUnread: row?.activeSessionUnread ?? 0,
        closedSessionUnread: row?.closedSessionUnread ?? 0,
        unmatchedUnread: row?.unmatchedUnread ?? 0,
        referrerUnread: row?.referrerUnread ?? 0,
      };
    },

    /**
     * The administrator inbox: every message, newest first, for a phone
     * number that has at least one message within retention that is not a
     * `reminder` — a `staff_reply`, a `household_reply` or a `failure`, real
     * or simulated makes no difference to a `reminder` either way. A number
     * that was only ever reminded, and never heard from, is not returned at
     * all — see `INITIAL_SPEC1.txt`, "SMS reminders and replies".
     *
     * Once a number qualifies, its whole retained history comes back in this
     * one call, reminders included, so opening one number's conversation
     * client-side is a filter over what is already here rather than a second
     * request. That is deliberate: the qualifying numbers are few (most
     * households never reply), so returning their full — still small —
     * threads costs far less than the reminder flood a `location`-only
     * filter would still have to read and discard on every visit.
     *
     * One query — the `EXISTS` is a subquery, not a second round trip — with
     * the session it was snapshotted against (null on a loose reply).
     *
     * A household with no number on file gets its `failure` rows written
     * with `phone: ''` (see `sms.service.ts`'s `attemptReminder`) — a
     * sentinel, not a real shared number, so two such households would look
     * like the same "phone" to this query. It is harmless here: that branch
     * never produces anything but a `failure`, which always qualifies on its
     * own regardless of any other row, so no blank-phone row ever needs
     * another blank-phone row's help to appear. It is not harmless in the
     * *response*, though — see `sms.mapper.ts`'s `inboxPhone`, which is
     * where this is actually handled.
     */
    async listInbox(cutoff: string): Promise<{ message: SmsMessage; session: Session | null }[]> {
      const otherMessage = alias(smsMessages, 'other_message');
      return db
        .select({ message: smsMessages, session: sessions })
        .from(smsMessages)
        .leftJoin(sessions, eq(smsMessages.sessionId, sessions.id))
        .where(
          and(
            gte(smsMessages.occurredAt, cutoff),
            exists(
              db
                .select({ one: sql`1` })
                .from(otherMessage)
                .where(
                  and(
                    eq(otherMessage.phone, smsMessages.phone),
                    gte(otherMessage.occurredAt, cutoff),
                    ne(otherMessage.kind, 'reminder'),
                  ),
                ),
            ),
          ),
        )
        .orderBy(desc(smsMessages.occurredAt));
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
     * Every referral holding a place on a session still open to a reply,
     * soonest first, for matching an inbound reply by phone number.
     *
     * "Still open" is the session's own London calendar date not having
     * passed yet, and it not being confirmed or cancelled — not its start
     * time. A delivery running past its start time, or a reply sent
     * mid-session, still has somewhere to land; only the day after, or a
     * sign-off, closes it. See `INITIAL_SPEC1.txt`, "SMS reminders and
     * replies".
     *
     * Phone comparison happens in memory (`phone.ts` normalises formats SQL
     * cannot usefully compare), so this hands back full rows rather than
     * filtering by number.
     */
    async referralsOnUpcomingSessions(
      nowUtc: string,
    ): Promise<{ referral: Referral; session: Session }[]> {
      const today = instantToLondonWallClock(nowUtc).date;
      return db
        .select({ referral: referrals, session: sessions })
        .from(referrals)
        .innerJoin(sessions, eq(referrals.sessionId, sessions.id))
        .where(
          and(
            gte(sessions.sessionDate, today),
            notInArray(sessions.status, [...CLOSED_SESSION_STATUSES]),
            inArray(referrals.status, [...REFERRAL_STATUSES_HOLDING_A_PLACE]),
          ),
        )
        .orderBy(asc(sessions.startsAtUtc));
    },

    /**
     * The single most recent session — any status, any date, unbounded by
     * "still open" — a phone number has ever been referred against, for the
     * fallback an inbound reply takes when `referralsOnUpcomingSessions`
     * finds nothing: a reply to a session that has already happened still
     * has somewhere to land, not just one still to come. Filtered in SQL on
     * `refereePhoneNormalised` (`idx_referrals_match_phone`) rather than in
     * memory like the two "still open" queries above — this one is not
     * date-bounded, so it cannot rely on a small candidate set the way they
     * do, and the phone has already been normalised by the caller.
     *
     * Two households sharing a phone number across the fifteen months this
     * data is held is accepted as negligible — see `INITIAL_SPEC1.txt`, "SMS
     * reminders and replies" — so the most recent session is taken without
     * checking whether an even-more-recent session exists for a *different*
     * referral on the same number; there is only ever meant to be one
     * household behind a given number at a time.
     */
    async latestSessionForPhone(
      phoneNormalised: string,
    ): Promise<{ referral: Referral; session: Session } | null> {
      const rows = await db
        .select({ referral: referrals, session: sessions })
        .from(referrals)
        .innerJoin(sessions, eq(referrals.sessionId, sessions.id))
        .where(eq(referrals.refereePhoneNormalised, phoneNormalised))
        .orderBy(desc(sessions.startsAtUtc))
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Every currently open `referrer_collect` referral, across every referrer
     * — not filtered by phone number in SQL, for the same reason
     * `referralsOnUpcomingSessions` is not: `phone.ts` normalises formats SQL
     * cannot usefully compare, so matching happens in memory. "Open" is the
     * same test `referralsOnUpcomingSessions` uses for a household reply —
     * holding a place, and the session neither past nor closed — because a
     * referrer's candidate parcels should never include one a household
     * reply could not land on either.
     */
    async referrerCollectReferralsOnUpcomingSessions(
      nowUtc: string,
    ): Promise<{ referral: Referral; session: Session }[]> {
      const today = instantToLondonWallClock(nowUtc).date;
      return db
        .select({ referral: referrals, session: sessions })
        .from(referrals)
        .innerJoin(sessions, eq(referrals.sessionId, sessions.id))
        .where(
          and(
            eq(referrals.collectionMethod, 'referrer_collect'),
            gte(sessions.sessionDate, today),
            notInArray(sessions.status, [...CLOSED_SESSION_STATUSES]),
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
