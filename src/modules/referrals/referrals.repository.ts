import { and, asc, count, eq, inArray, notInArray, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  auditEvents,
  referrals,
  REFERRAL_STATUSES_HOLDING_A_PLACE,
  type NewAuditEvent,
  type NewReferral,
  type Referral,
  type ReferralStatus,
} from '../../db/schema/referrals.ts';
import type { Patch } from '../../core/types.ts';

export interface ReferralListFilter {
  readonly sessionId?: string | undefined;
  readonly status?: ReferralStatus | undefined;
  /** Statuses the caller is not allowed to know exist. See the service. */
  readonly excludeStatuses?: readonly ReferralStatus[] | undefined;
}

export function createReferralsRepository(db: Database) {
  return {
    async findById(id: string): Promise<Referral | undefined> {
      const rows = await db.select().from(referrals).where(eq(referrals.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    async list(filter: ReferralListFilter): Promise<Referral[]> {
      const conditions: SQL[] = [];
      if (filter.sessionId !== undefined)
        conditions.push(eq(referrals.sessionId, filter.sessionId));
      if (filter.status !== undefined) conditions.push(eq(referrals.status, filter.status));
      if (filter.excludeStatuses !== undefined && filter.excludeStatuses.length > 0) {
        conditions.push(notInArray(referrals.status, [...filter.excludeStatuses]));
      }

      return db
        .select()
        .from(referrals)
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(asc(referrals.referredAt));
    },

    /**
     * Households occupying a place on a session.
     *
     * Capacity counts referrals, not people, and a referral awaiting review
     * counts — see `REFERRAL_STATUSES_HOLDING_A_PLACE`. One aggregate query
     * rather than fetching rows to count them in TypeScript.
     */
    async countHoldingAPlace(sessionId: string): Promise<number> {
      const rows = await db
        .select({ booked: count() })
        .from(referrals)
        .where(
          and(
            eq(referrals.sessionId, sessionId),
            inArray(referrals.status, [...REFERRAL_STATUSES_HOLDING_A_PLACE]),
          ),
        );
      return rows[0]?.booked ?? 0;
    },

    async insert(value: NewReferral): Promise<Referral> {
      const rows = await db.insert(referrals).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert referral');
      return inserted;
    },

    async update(id: string, patch: Patch<NewReferral>): Promise<Referral | undefined> {
      const rows = await db.update(referrals).set(patch).where(eq(referrals.id, id)).returning();
      return expectAtMostOne(rows);
    },

    /**
     * Records a review decision, but **only** on a referral still awaiting one.
     *
     * The condition travels with the write rather than being checked in the
     * service first. D1 has no interactive transactions, so a read-then-write
     * would let two administrators working the same queue — or one
     * double-clicking — both see `pending_review` and both write, and the last
     * one silently wins. An accept quietly overwriting a reject is the outcome
     * that matters: nobody is told, and a household the charity turned away is
     * back on the session. Same shape as `updateLeavingAnotherAdmin`.
     *
     * Returns `undefined` when nothing matched, which the service reads as
     * "somebody else got there first".
     */
    async reviewIfPending(id: string, patch: Patch<NewReferral>): Promise<Referral | undefined> {
      const rows = await db
        .update(referrals)
        .set(patch)
        .where(and(eq(referrals.id, id), eq(referrals.status, 'pending_review')))
        .returning();
      return expectAtMostOne(rows);
    },

    async recordAudit(value: NewAuditEvent): Promise<void> {
      await db.insert(auditEvents).values(value);
    },

    async listAuditFor(entityType: string, entityId: string) {
      return db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.entityType, entityType), eq(auditEvents.entityId, entityId)))
        .orderBy(asc(auditEvents.occurredAt));
    },

    // ---- Statement builders. Compose these, then run ONE db.batch(). ----

    buildInsertReferral(value: NewReferral) {
      return db.insert(referrals).values(value);
    },

    buildAudit(value: NewAuditEvent) {
      return db.insert(auditEvents).values(value);
    },
  };
}

export type ReferralsRepository = ReturnType<typeof createReferralsRepository>;
