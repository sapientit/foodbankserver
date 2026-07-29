import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  authorisedReferrers,
  referralReasons,
  type AuthorisedReferrer,
  type NewAuthorisedReferrer,
  type NewReferralReason,
  type ReferralReason,
} from '../../db/schema/referrers.ts';
import type { Patch } from '../../core/types.ts';
import type { ReferrerCandidate } from './matching.ts';

export function createReferrersRepository(db: Database) {
  return {
    /**
     * Both possible matches for an address in **one** query.
     *
     * Inactive rows are returned rather than filtered, because an inactive
     * exact-email row must still beat an active domain row — see
     * `resolveAuthorisation`. Filtering here would silently unblock people.
     */
    async findCandidates(email: string, domain: string | undefined): Promise<ReferrerCandidate[]> {
      const matchValues = domain === undefined ? [email] : [email, domain];

      return db
        .select({
          id: authorisedReferrers.id,
          matchType: authorisedReferrers.matchType,
          matchValue: authorisedReferrers.matchValue,
          organisationName: authorisedReferrers.organisationName,
          isActive: authorisedReferrers.isActive,
        })
        .from(authorisedReferrers)
        .where(inArray(authorisedReferrers.matchValue, matchValues));
    },

    async list(): Promise<AuthorisedReferrer[]> {
      return db
        .select()
        .from(authorisedReferrers)
        .orderBy(asc(authorisedReferrers.organisationName), asc(authorisedReferrers.matchValue));
    },

    async findById(id: string): Promise<AuthorisedReferrer | undefined> {
      const rows = await db
        .select()
        .from(authorisedReferrers)
        .where(eq(authorisedReferrers.id, id))
        .limit(1);
      return expectAtMostOne(rows);
    },

    async insert(value: NewAuthorisedReferrer): Promise<AuthorisedReferrer> {
      const rows = await db.insert(authorisedReferrers).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert authorised referrer');
      return inserted;
    },

    async update(
      id: string,
      patch: Patch<NewAuthorisedReferrer>,
    ): Promise<AuthorisedReferrer | undefined> {
      const rows = await db
        .update(authorisedReferrers)
        .set(patch)
        .where(eq(authorisedReferrers.id, id))
        .returning();
      return expectAtMostOne(rows);
    },

    // ---- Reasons ----

    async listReasons(activeOnly: boolean): Promise<ReferralReason[]> {
      return db
        .select()
        .from(referralReasons)
        .where(activeOnly ? eq(referralReasons.isActive, 1) : undefined)
        .orderBy(asc(referralReasons.displayOrder), asc(referralReasons.label));
    },

    async findReasonById(id: string): Promise<ReferralReason | undefined> {
      const rows = await db
        .select()
        .from(referralReasons)
        .where(eq(referralReasons.id, id))
        .limit(1);
      return expectAtMostOne(rows);
    },

    /** Used when accepting a referral: the reason must exist AND still be offered. */
    async findActiveReasonById(id: string): Promise<ReferralReason | undefined> {
      const rows = await db
        .select()
        .from(referralReasons)
        .where(and(eq(referralReasons.id, id), eq(referralReasons.isActive, 1)))
        .limit(1);
      return expectAtMostOne(rows);
    },

    async insertReason(value: NewReferralReason): Promise<ReferralReason> {
      const rows = await db.insert(referralReasons).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert referral reason');
      return inserted;
    },

    async updateReason(
      id: string,
      patch: Patch<NewReferralReason>,
    ): Promise<ReferralReason | undefined> {
      const rows = await db
        .update(referralReasons)
        .set(patch)
        .where(eq(referralReasons.id, id))
        .returning();
      return expectAtMostOne(rows);
    },
  };
}

export type ReferrersRepository = ReturnType<typeof createReferrersRepository>;
