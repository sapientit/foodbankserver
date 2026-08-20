import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { referrals, REFERRAL_STATUSES_HOLDING_A_PLACE } from '../../db/schema/referrals.ts';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  recurringSessions,
  sessions,
  type NewRecurringSession,
  type NewSession,
  type RecurringSession,
  type Session,
  type SessionStatus,
} from '../../db/schema/sessions.ts';
import type { PlainDate } from '../../core/time/plain-date.ts';
import type { Patch } from '../../core/types.ts';

/**
 * Referrals that occupy a place, for every capacity count in this file.
 *
 * A referral awaiting review holds its place, so a session fills with everyone
 * who might come. Cancelled and rejected referrals give their place back.
 * Written once so the three places that count capacity cannot drift apart.
 */
const holdsAPlace = inArray(referrals.status, [...REFERRAL_STATUSES_HOLDING_A_PLACE]);

export interface SessionListFilter {
  readonly from?: PlainDate | undefined;
  readonly to?: PlainDate | undefined;
  readonly status?: SessionStatus | undefined;
}

/**
 * A session plus how many households are booked onto it.
 *
 * Carried as a pair rather than folded into `Session`, because `Session` is the
 * table row and `booked` is derived. Keeping them apart is what stops a derived
 * count being written back by accident.
 */
export interface SessionWithBooked {
  readonly session: Session;
  readonly booked: number;
}

export function createSessionsRepository(db: Database) {
  return {
    async listRecurring(): Promise<RecurringSession[]> {
      return db
        .select()
        .from(recurringSessions)
        .orderBy(asc(recurringSessions.weekday), asc(recurringSessions.startTime));
    },

    /**
     * Templates whose activity range overlaps the horizon. One query — the
     * materialisation job must not scale its query count with template count.
     */
    async listRecurringActiveInWindow(from: PlainDate, to: PlainDate): Promise<RecurringSession[]> {
      return db
        .select()
        .from(recurringSessions)
        .where(
          and(
            lte(recurringSessions.activeFrom, to),
            or(isNull(recurringSessions.activeUntil), gte(recurringSessions.activeUntil, from)),
          ),
        )
        .orderBy(asc(recurringSessions.weekday));
    },

    async findRecurringById(id: string): Promise<RecurringSession | undefined> {
      const rows = await db
        .select()
        .from(recurringSessions)
        .where(eq(recurringSessions.id, id))
        .limit(1);
      return expectAtMostOne(rows);
    },

    async insertRecurring(value: NewRecurringSession): Promise<RecurringSession> {
      const rows = await db.insert(recurringSessions).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert recurring session');
      return inserted;
    },

    async updateRecurring(
      id: string,
      patch: Patch<NewRecurringSession>,
    ): Promise<RecurringSession | undefined> {
      const rows = await db
        .update(recurringSessions)
        .set(patch)
        .where(eq(recurringSessions.id, id))
        .returning();
      return expectAtMostOne(rows);
    },

    async findById(id: string): Promise<Session | undefined> {
      const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    /**
     * Sessions in a date window, each with its booked count.
     *
     * **One query, whatever the session count.** This route is unpaginated, so
     * counting referrals per session would scale query count with result size
     * and blow the per-invocation query limit on a wide window. The left join
     * plus `GROUP BY` is the same shape `listPubliclyAvailable` uses below,
     * minus the `HAVING` — an admin needs to see full sessions, not have them
     * filtered out.
     *
     * Cancelled and rejected referrals do not occupy a place, hence the status
     * condition inside the join rather than in the `WHERE`: putting it outside
     * would drop sessions whose only referrals are cancelled.
     */
    async list(filter: SessionListFilter): Promise<SessionWithBooked[]> {
      const conditions: SQL[] = [];
      if (filter.from !== undefined) conditions.push(gte(sessions.sessionDate, filter.from));
      if (filter.to !== undefined) conditions.push(lte(sessions.sessionDate, filter.to));
      if (filter.status !== undefined) conditions.push(eq(sessions.status, filter.status));

      return db
        .select({ session: sessions, booked: count(referrals.id) })
        .from(sessions)
        .leftJoin(referrals, and(eq(referrals.sessionId, sessions.id), holdsAPlace))
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .groupBy(sessions.id)
        .orderBy(asc(sessions.startsAtUtc));
    },

    /** Households booked onto one session. For single-resource responses. */
    async bookedFor(sessionId: string): Promise<number> {
      const rows = await db
        .select({ booked: count() })
        .from(referrals)
        .where(and(eq(referrals.sessionId, sessionId), holdsAPlace));
      return rows[0]?.booked ?? 0;
    },

    /**
     * Sessions open to the public within an instant window, excluding any that
     * are full.
     *
     * **One query**, not one per session: this is unauthenticated, and the free
     * plan allows only 50 queries per invocation. The left join plus `HAVING`
     * does the capacity filter in SQL rather than fetching every session and
     * counting referrals per row.
     *
     * Capacity counts referrals (households), not people — cancelled and
     * rejected ones do not occupy a place, and one awaiting review does, hence
     * the status condition inside the join.
     *
     * `deliveryBooked` is the same join split further by `isDelivery`, not a
     * second join — the rows are already being joined for `booked`.
     */
    async listPubliclyAvailable(
      fromUtc: string,
      toUtc: string,
    ): Promise<{ session: Session; deliveryBooked: number }[]> {
      const rows = await db
        .select({
          session: sessions,
          booked: count(referrals.id),
          deliveryBooked: sql<number>`sum(case when ${referrals.isDelivery} = 1 then 1 else 0 end)`,
        })
        .from(sessions)
        .leftJoin(referrals, and(eq(referrals.sessionId, sessions.id), holdsAPlace))
        .where(
          and(
            eq(sessions.status, 'planned'),
            gte(sessions.startsAtUtc, fromUtc),
            lte(sessions.startsAtUtc, toUtc),
          ),
        )
        .groupBy(sessions.id)
        .having(lt(count(referrals.id), sessions.capacity))
        .orderBy(asc(sessions.startsAtUtc));

      return rows.map((row) => ({ session: row.session, deliveryBooked: row.deliveryBooked }));
    },

    /** Template slots already materialised in a date range. */
    async findExistingOccurrences(
      from: PlainDate,
      to: PlainDate,
    ): Promise<{ recurringSessionId: string | null; occurrenceDate: string | null }[]> {
      return db
        .select({
          recurringSessionId: sessions.recurringSessionId,
          occurrenceDate: sessions.occurrenceDate,
        })
        .from(sessions)
        .where(
          and(
            isNotNull(sessions.recurringSessionId),
            gte(sessions.occurrenceDate, from),
            lte(sessions.occurrenceDate, to),
          ),
        );
    },

    async insertSession(value: NewSession): Promise<Session> {
      const rows = await db.insert(sessions).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert session');
      return inserted;
    },

    async updateSession(id: string, patch: Patch<NewSession>): Promise<Session | undefined> {
      const rows = await db.update(sessions).set(patch).where(eq(sessions.id, id)).returning();
      return expectAtMostOne(rows);
    },

    /**
     * Claims the next session to extract, atomically.
     *
     * The oldest confirmed session that has not been extracted and is not
     * currently claimed by anybody, reserved to this administrator in **one
     * statement**. That is the whole point: D1 has no interactive
     * transactions, so "find the next one, then reserve it" cannot be made
     * safe by doing the two in sequence — two administrators working the
     * queue together would read the same row and both go on to write it to
     * the spreadsheet. The subquery picks the row and the `UPDATE` reserves
     * it in the same breath, so exactly one of two racing callers gets it and
     * the other gets the next one down.
     *
     * The `WHERE` guards are repeated outside the subquery on purpose. They
     * are what makes the statement claim *that specific row only if it is
     * still free*, rather than trusting the subquery's answer to still be
     * true by the time the write lands.
     *
     * A claim whose expiry has passed counts as free. That is how an
     * abandoned extract recovers: the browser holding it closed, slept or
     * reloaded, and nothing else can ever finish that session.
     *
     * Returns `undefined` when the queue is empty — nothing confirmed is
     * waiting, or everything waiting is claimed by somebody still working.
     */
    async claimNextForExtract(claim: {
      readonly claimId: string;
      readonly userId: string;
      readonly expiresAt: string;
      readonly now: string;
    }): Promise<Session | undefined> {
      const claimable = and(
        eq(sessions.status, 'confirmed'),
        isNull(sessions.extractedAt),
        or(isNull(sessions.extractClaimExpiresAt), lte(sessions.extractClaimExpiresAt, claim.now)),
      );

      const next = db
        .select({ id: sessions.id })
        .from(sessions)
        .where(claimable)
        // `id` breaks the tie so two sessions on the same date cannot leave
        // the order undefined, which would make the queue non-deterministic.
        .orderBy(asc(sessions.sessionDate), asc(sessions.id))
        .limit(1);

      const rows = await db
        .update(sessions)
        .set({
          extractClaimId: claim.claimId,
          extractClaimedByUserId: claim.userId,
          extractClaimExpiresAt: claim.expiresAt,
          updatedAt: claim.now,
        })
        .where(and(inArray(sessions.id, next), claimable))
        .returning();

      return expectAtMostOne(rows);
    },

    /** The session a claim id refers to, whatever state that claim is in. */
    async findByExtractClaim(claimId: string): Promise<Session | undefined> {
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.extractClaimId, claimId))
        .limit(1);
      return expectAtMostOne(rows);
    },

    /**
     * Marks a claimed session extracted.
     *
     * **Guarded on the claim id and on the claim not having lapsed**, so a
     * completion cannot land on a session that has since been handed to
     * somebody else. The condition travels with the write for the same reason
     * the claim does: there is no transaction to hold it still in between.
     *
     * The claim columns are deliberately **left in place**. A browser that
     * retried a completion whose response it never saw presents the same
     * claim id again, and the service recognises it as this claim having
     * already finished this session rather than as a conflict.
     *
     * `undefined` means the guard did not hold; the service re-reads to say
     * why, which is the only way to tell "expired" from "not yours" from
     * "already done".
     */
    async markExtracted(claim: {
      readonly claimId: string;
      readonly userId: string;
      readonly at: string;
    }): Promise<Session | undefined> {
      const rows = await db
        .update(sessions)
        .set({ extractedAt: claim.at, updatedAt: claim.at })
        .where(
          and(
            eq(sessions.extractClaimId, claim.claimId),
            // **The holder, not merely the holder of the id.** Without this the
            // guard would accept any administrator presenting an unexpired
            // claim id, and a session would be marked extracted on the
            // strength of a write that browser never did — after which it is
            // never offered again, silently dropping it from the spreadsheet.
            // That is the one failure the charity said must not happen
            // quietly. It also makes the service's "belongs to another
            // administrator" branch reachable, which it otherwise is not.
            eq(sessions.extractClaimedByUserId, claim.userId),
            isNull(sessions.extractedAt),
            gte(sessions.extractClaimExpiresAt, claim.at),
          ),
        )
        .returning();
      return expectAtMostOne(rows);
    },

    /**
     * How many confirmed sessions are still waiting, and how many have gone.
     *
     * Feeds the progress the browser shows while it works through a batch,
     * and the "carry on?" question it asks after twenty. `remaining` counts
     * everything unextracted, including sessions another administrator holds
     * a live claim on — from the operator's point of view those are still
     * outstanding work, just not theirs this minute.
     */
    async extractProgress(): Promise<{ remaining: number; extracted: number }> {
      const rows = await db
        .select({
          remaining: sql<number>`sum(case when ${sessions.extractedAt} is null then 1 else 0 end)`,
          extracted: sql<number>`sum(case when ${sessions.extractedAt} is not null then 1 else 0 end)`,
        })
        .from(sessions)
        .where(eq(sessions.status, 'confirmed'));

      const row = expectAtMostOne(rows);
      return { remaining: row?.remaining ?? 0, extracted: row?.extracted ?? 0 };
    },

    // ---- Statement builders. Compose these, then run ONE db.batch(). ----

    /**
     * `ON CONFLICT DO NOTHING` against the occurrence unique index.
     *
     * Belt and braces on top of the diff: if two runs ever overlap, the loser
     * skips the row it lost rather than aborting the batch and discarding the
     * other seventeen sessions it was going to create.
     */
    buildInsertSession(value: NewSession) {
      return db.insert(sessions).values(value).onConflictDoNothing();
    },
  };
}

export type SessionsRepository = ReturnType<typeof createSessionsRepository>;
