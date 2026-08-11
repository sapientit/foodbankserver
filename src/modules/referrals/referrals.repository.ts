import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  max,
  ne,
  notInArray,
  or,
  type SQL,
} from 'drizzle-orm';
import { REPEAT_REFERRAL_LIST_LIMIT } from '../../config/constants.ts';
import type { AgeBands } from './age-bands.ts';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import { parcels, type AttendanceStatus } from '../../db/schema/pick-lists.ts';
import {
  auditEvents,
  referrals,
  REFERRAL_STATUSES_HOLDING_A_PLACE,
  type NewAuditEvent,
  type NewReferral,
  type Referral,
  type ReferralStatus,
} from '../../db/schema/referrals.ts';
import { sessions } from '../../db/schema/sessions.ts';
import type { Patch } from '../../core/types.ts';
import type { MatchableFields } from './matching.ts';

export interface ReferralListFilter {
  readonly sessionId?: string | undefined;
  readonly status?: ReferralStatus | undefined;
  /**
   * Several statuses at once, for callers that want a stage of the pipeline
   * rather than one value — picking uses every status that holds a place, so
   * its client has a parcel for every household it may need to run.
   */
  readonly statuses?: readonly ReferralStatus[] | undefined;
  /** Statuses the caller is not allowed to know exist. See the service. */
  readonly excludeStatuses?: readonly ReferralStatus[] | undefined;
}

/**
 * One candidate row for the repeat-referral list: the referral's own
 * settled fields plus its session date, and the two matched columns
 * (`postcodeNormalised`, `phoneNormalised`) so the service can work out
 * `matchedOn` without a second query. Not a response shape — the mapper is
 * the allowlist that drops the normalised columns before this reaches a
 * client.
 */
export interface RepeatReferralCandidate {
  readonly id: string;
  readonly sessionId: string;
  readonly sessionDate: string;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereeDateOfBirth: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly postcodeNormalised: string | null;
  readonly phoneNormalised: string | null;
}

/**
 * The predicate shared by the summary and the full list.
 *
 * `INITIAL_SPEC1.txt`, `#Reviewing a referral`: the count is of referrals,
 * not of parcels handed over, so a referral counts unless it was cancelled or
 * rejected — awaiting review, active, reviewed and not-yet-attended all
 * count. Excluding `parcels` from this predicate entirely is deliberate: a
 * household referred to two sessions in the same week has to be caught
 * before either has been picked, packed and given out.
 *
 * `or(...)` carries only the comparisons whose value on the reviewed
 * referral is non-null. Each remaining comparison is `eq` against a column
 * that is itself nullable on the candidate side, and SQL's `eq` never
 * matches a `NULL` — so "the candidate has no postcode on file" already
 * fails to match without an extra `isNotNull`, and adding one would only
 * restate what `eq` already guarantees.
 *
 * Callers guard `hasAnythingToMatchOn` before reaching here, so `matchers`
 * below is never empty — but the throw is not decoration. An empty `or(...)`
 * returns `undefined`, `and(...)` silently drops an `undefined` term, and the
 * predicate would then match **every referral in the twelve-month window**.
 * On the summary that is a wrong number; on the list it is every household
 * the food bank has fed this year, with their names, addresses and phone
 * numbers, handed to whoever opened one referral. Failing loudly is the only
 * acceptable behaviour, and it costs one comparison.
 */
function repeatReferralPredicate(
  fields: MatchableFields,
  selfId: string,
  cutoff: string,
): SQL | undefined {
  const matchers: SQL[] = [];
  if (fields.dateOfBirth !== null) {
    matchers.push(eq(referrals.refereeDateOfBirth, fields.dateOfBirth));
  }
  if (fields.postcodeNormalised !== null) {
    matchers.push(eq(referrals.refereePostcodeNormalised, fields.postcodeNormalised));
  }
  if (fields.phoneNormalised !== null) {
    matchers.push(eq(referrals.refereePhoneNormalised, fields.phoneNormalised));
  }

  if (matchers.length === 0) {
    throw new Error('Repeat-referral predicate built with nothing to match on');
  }

  return and(
    ne(referrals.id, selfId),
    notInArray(referrals.status, ['cancelled', 'rejected']),
    gte(referrals.referredAt, cutoff),
    or(...matchers),
  );
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
      if (filter.statuses !== undefined) {
        conditions.push(inArray(referrals.status, [...filter.statuses]));
      }
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
     * Moves a referral along the pipeline, but **only** from the status it is
     * expected to be in.
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
    async updateIfStatus(
      id: string,
      from: ReferralStatus,
      patch: Patch<NewReferral>,
    ): Promise<Referral | undefined> {
      const rows = await db
        .update(referrals)
        .set(patch)
        .where(and(eq(referrals.id, id), eq(referrals.status, from)))
        .returning();
      return expectAtMostOne(rows);
    },

    /**
     * Amends a referral, but **only** while its four age bands are still the
     * ones the caller validated against.
     *
     * The condition travels with the write for the same reason it does in
     * `updateIfStatus`, and the failure it prevents is subtler. A patch may
     * carry one band; the rule that a household must include somebody aged
     * twelve or over is about two of them; and `adults` is derived from both.
     * So the service has to merge the patch with the stored row before it can
     * decide anything — and on D1 that read cannot be held. Two administrators
     * amending the same household, one clearing `teenagers12To17` and the other
     * clearing `adults18Plus`, would each merge against a row that still had
     * the other's value, each see a household with somebody twelve or over,
     * and both write. The row left behind has neither, and an `adults` count
     * derived from a household that never existed.
     *
     * Comparing the bands rather than a version column keeps the guard on
     * exactly what the derivation reads: an amendment that touches only an
     * address never contends with one that touches only a band.
     *
     * Returns `undefined` when nothing matched, which the service reads as
     * "the household changed underneath this amendment".
     */
    async updateIfBandsUnchanged(
      id: string,
      patch: Patch<NewReferral>,
      expected: AgeBands,
    ): Promise<Referral | undefined> {
      const rows = await db
        .update(referrals)
        .set(patch)
        .where(
          and(
            eq(referrals.id, id),
            eq(referrals.infants, expected.infants),
            eq(referrals.children4To11, expected.children4To11),
            eq(referrals.teenagers12To17, expected.teenagers12To17),
            eq(referrals.adults18Plus, expected.adults18Plus),
          ),
        )
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

    /**
     * The repeat-referral summary: how many, and the most recent session
     * date among them. One aggregate query, no PII selected or returned —
     * this is what the review screen shows before anybody presses the
     * button for the full list.
     *
     * `count()` and `max()` with no `GROUP BY` always return exactly one
     * row, including when nothing matches (`count` 0, `max` `null`), so
     * `expectAtMostOne` here is narrowing the type, not handling a case that
     * can occur.
     */
    async countRepeatReferrals(
      fields: MatchableFields,
      selfId: string,
      cutoff: string,
    ): Promise<{ count: number; mostRecentSessionDate: string | null }> {
      const rows = await db
        .select({ matches: count(), mostRecentSessionDate: max(sessions.sessionDate) })
        .from(referrals)
        .innerJoin(sessions, eq(sessions.id, referrals.sessionId))
        .where(repeatReferralPredicate(fields, selfId, cutoff));

      const row = expectAtMostOne(rows);
      return {
        count: row?.matches ?? 0,
        mostRecentSessionDate: row?.mostRecentSessionDate ?? null,
      };
    },

    /**
     * The matching referrals in full, for the button behind the summary.
     *
     * The session date is the referral's **own** `sessionId`, not a
     * parcel's — unlike the fuel help list, this reports referrals, and a
     * moved referral's current session is where the household is now
     * expected. Ordered by session date descending: most recent match
     * first.
     *
     * **Capped at `REPEAT_REFERRAL_LIST_LIMIT`**, and the ordering is what
     * makes the cap defensible rather than arbitrary — the fifty an
     * administrator would actually read are the fifty they get. The count
     * comes from `countRepeatReferrals` above and is **not** capped, so a
     * truncated list is visible as a shorter list than the count.
     */
    async listRepeatReferrals(
      fields: MatchableFields,
      selfId: string,
      cutoff: string,
    ): Promise<RepeatReferralCandidate[]> {
      return db
        .select({
          id: referrals.id,
          sessionId: referrals.sessionId,
          sessionDate: sessions.sessionDate,
          refereeFirstName: referrals.refereeFirstName,
          refereeSurname: referrals.refereeSurname,
          refereeDateOfBirth: referrals.refereeDateOfBirth,
          refereeAddress: referrals.refereeAddress,
          refereePostcode: referrals.refereePostcode,
          refereePhone: referrals.refereePhone,
          postcodeNormalised: referrals.refereePostcodeNormalised,
          phoneNormalised: referrals.refereePhoneNormalised,
        })
        .from(referrals)
        .innerJoin(sessions, eq(sessions.id, referrals.sessionId))
        .where(repeatReferralPredicate(fields, selfId, cutoff))
        .orderBy(desc(sessions.sessionDate))
        .limit(REPEAT_REFERRAL_LIST_LIMIT);
    },

    /**
     * The parcel attendance of every referral the same predicate matches, for
     * deriving `outcome` on the full list.
     *
     * A **separate query** rather than a `left join` on `listRepeatReferrals`
     * above: a referral moved to another session after a pick list was
     * generated can hold a parcel on each of two pick lists, and joining
     * would duplicate the referral row.
     *
     * **It re-runs the predicate rather than taking the ids the other query
     * returned**, which looks like the long way round and is not.
     * `inArray` binds one parameter per id and D1 allows a hundred per
     * statement, so an id list would fail once a household matched more than
     * a hundred referrals — see `docs/engineering/d1-constraints.md`, which
     * already records `inArray` as the wrong answer to exactly this shape of
     * problem. A hundred is not a hypothetical ceiling here: the spec expects
     * a postcode alone to match a whole hostel or refuge, which is precisely
     * the housing these households live in. Re-running the predicate binds
     * the same three or four values however many rows come back.
     */
    async listAttendanceForRepeatReferrals(
      fields: MatchableFields,
      selfId: string,
      cutoff: string,
    ): Promise<{ referralId: string; attendance: AttendanceStatus }[]> {
      return db
        .select({ referralId: parcels.referralId, attendance: parcels.attendance })
        .from(parcels)
        .innerJoin(referrals, eq(referrals.id, parcels.referralId))
        .where(repeatReferralPredicate(fields, selfId, cutoff));
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
