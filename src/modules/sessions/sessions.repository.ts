import { and, asc, count, eq, gte, isNotNull, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
import { referrals } from '../../db/schema/referrals.ts';
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

export interface SessionListFilter {
  readonly from?: PlainDate | undefined;
  readonly to?: PlainDate | undefined;
  readonly status?: SessionStatus | undefined;
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

    async list(filter: SessionListFilter): Promise<Session[]> {
      const conditions: SQL[] = [];
      if (filter.from !== undefined) conditions.push(gte(sessions.sessionDate, filter.from));
      if (filter.to !== undefined) conditions.push(lte(sessions.sessionDate, filter.to));
      if (filter.status !== undefined) conditions.push(eq(sessions.status, filter.status));

      return db
        .select()
        .from(sessions)
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(asc(sessions.startsAtUtc));
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
     * Capacity counts referrals (households), not people — cancelled ones do
     * not occupy a place, hence the status condition inside the join.
     */
    async listPubliclyAvailable(fromUtc: string, toUtc: string): Promise<Session[]> {
      const rows = await db
        .select({ session: sessions, booked: count(referrals.id) })
        .from(sessions)
        .leftJoin(
          referrals,
          and(eq(referrals.sessionId, sessions.id), eq(referrals.status, 'active')),
        )
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

      return rows.map((row) => row.session);
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
