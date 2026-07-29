import { and, asc, count, eq, gte, lt, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  auditEvents,
  referralEditKeys,
  referrals,
  type NewAuditEvent,
  type NewReferral,
  type NewReferralEditKey,
  type Referral,
  type ReferralEditKey,
  type ReferralStatus,
} from '../../db/schema/referrals.ts';
import type { Patch } from '../../core/types.ts';

export interface ReferralListFilter {
  readonly sessionId?: string | undefined;
  readonly status?: ReferralStatus | undefined;
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

      return db
        .select()
        .from(referrals)
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(asc(referrals.referredAt));
    },

    /**
     * Households booked onto a session.
     *
     * Capacity counts referrals, not people. One aggregate query rather than
     * fetching rows to count them in TypeScript.
     */
    async countActiveForSession(sessionId: string): Promise<number> {
      const rows = await db
        .select({ booked: count() })
        .from(referrals)
        .where(and(eq(referrals.sessionId, sessionId), eq(referrals.status, 'active')));
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

    // ---- Edit keys ----

    async findEditKeyByHash(keyHash: string): Promise<ReferralEditKey | undefined> {
      const rows = await db
        .select()
        .from(referralEditKeys)
        .where(eq(referralEditKeys.keyHash, keyHash))
        .limit(1);
      return expectAtMostOne(rows);
    },

    async recordEditKeyUse(id: string, useCount: number): Promise<void> {
      await db.update(referralEditKeys).set({ useCount }).where(eq(referralEditKeys.id, id));
    },

    async consumeEditKey(id: string, at: number): Promise<void> {
      await db.update(referralEditKeys).set({ consumedAt: at }).where(eq(referralEditKeys.id, id));
    },

    /**
     * Deletes keys that expired before `before`.
     *
     * The caller leaves a grace period so a key that expired recently is still
     * present, which is what lets the handler answer 410 Gone ("your window
     * closed") rather than 403 ("no such key") for a day. Much kinder to a
     * referrer who was slow filling the form in.
     */
    async deleteExpiredEditKeys(before: number): Promise<number> {
      const result = await db
        .delete(referralEditKeys)
        .where(lt(referralEditKeys.expiresAt, before))
        .returning({ id: referralEditKeys.id });
      return result.length;
    },

    async countEditKeysExpiringAfter(instant: number): Promise<number> {
      const rows = await db
        .select({ remaining: count() })
        .from(referralEditKeys)
        .where(gte(referralEditKeys.expiresAt, instant));
      return rows[0]?.remaining ?? 0;
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

    buildInsertEditKey(value: NewReferralEditKey) {
      return db.insert(referralEditKeys).values(value);
    },

    buildAudit(value: NewAuditEvent) {
      return db.insert(auditEvents).values(value);
    },
  };
}

export type ReferralsRepository = ReturnType<typeof createReferralsRepository>;
