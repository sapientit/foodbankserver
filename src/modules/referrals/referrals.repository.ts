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
  sql,
  type SQL,
} from 'drizzle-orm';
import { REFERRAL_SEARCH_LIMIT, REPEAT_REFERRAL_LIST_LIMIT } from '../../config/constants.ts';
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

/**
 * One candidate row for `POST /referrals/search` — the administrator's
 * working row, and nothing beyond it.
 *
 * **It selects no date of birth, address or normalised column.** Those were
 * here to compute `matchedOn`, which the charity dropped from the result: a
 * row now says who and when, not which of the caller's three values happened
 * to be the one that hit. Not selecting them at all is a stronger guarantee
 * than mapping them away afterwards, and `referrals.mapper.ts` is still the
 * allowlist that decides what leaves.
 */
export interface ReferralSearchCandidate {
  readonly id: string;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly sessionDate: string;
  readonly status: ReferralStatus;
  /** `NOT NULL` on the table, and outside the PII block, so a purge leaves it. */
  readonly reasonId: string;
  readonly referrerName: string | null;
  /**
   * The dynamic answers blob, unparsed. The mapper turns it into an object;
   * the server never looks inside it. See `toReferralSearchResult`.
   */
  readonly answersJson: string | null;
}

/**
 * The predicate for `POST /referrals/search`.
 *
 * **Deliberately not built by generalising `repeatReferralPredicate`.** That
 * one carries three conditions this search must not: it excludes the
 * referral under review, it stops at twelve months, and it drops cancelled
 * and rejected referrals. A search reaches every referral the food bank
 * still holds details for, whatever became of it —
 * `INITIAL_SPEC1.txt`, `#Searching for a referral` — because "we turned that
 * one away in March" is exactly what the person on the phone is ringing
 * about. Threading a flag through one shared function to turn three
 * conditions on and off would risk the flag being wrong in the one place —
 * cancelled and rejected referrals leaking into the twelve-month duplicate
 * list — that actually matters.
 *
 * Purged referrals cannot match: the purge nulls `refereeDateOfBirth`,
 * `refereePostcodeNormalised` and `refereePhoneNormalised`, and SQL's `eq`
 * never matches `NULL`. No `piiPurgedAt` filter here for the same reason
 * there is none on the predicate above — it would only be a second, weaker
 * statement of a rule the nulled columns already enforce.
 *
 * Same "the throw is not decoration" reasoning as `repeatReferralPredicate`:
 * callers guard `hasAnythingToMatchOn` first, so `matchers` is never empty in
 * practice, but an empty `or(...)` returns `undefined` and a `WHERE undefined`
 * would return every referral the food bank has ever held.
 *
 * **`surnamePrefix` narrows, and is `AND`ed around the whole `or(...)`.** The
 * bracketing is the entire point: `A OR B AND C` binds as `A OR (B AND C)` in
 * SQL, so a filter written flat alongside the identifiers would leave the
 * date-of-birth arm unfiltered and quietly return the households the
 * administrator asked to exclude. It is applied to the count and to the capped
 * rows through this one function, so the two cannot drift apart.
 */
function referralSearchPredicate(
  fields: MatchableFields,
  surnamePrefix: string | null,
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
    throw new Error('Referral search predicate built with nothing to match on');
  }

  const identifiers = or(...matchers);
  return surnamePrefix === null ? identifiers : and(identifiers, surnameStartsWith(surnamePrefix));
}

/**
 * Case-insensitive start-of-surname: the surname cut to the prefix's length,
 * compared for equality.
 *
 * **Deliberately not `LIKE 'prefix%'`, which is what this was first written
 * as and which was a `500` waiting for production.** SQLite refuses a `LIKE`
 * pattern over fifty characters with `LIKE or GLOB pattern too complex`, and
 * the schema allows a hundred — twice that once `%` and `_` are escaped. Worse,
 * **SQLite only evaluates the pattern once there is a row to evaluate it
 * against**, so it passed every test against a database that had not been
 * seeded yet. That is the identical trap migration `0019` fell into; see
 * `docs/engineering/d1-constraints.md`. Comparing a substring has no pattern
 * and therefore no ceiling, and it needs no metacharacter escaping at all —
 * a `%` is just a character that no surname starts with.
 *
 * A `NULL` surname still drops out: `substr(NULL, …)` is `NULL` and `NULL = x`
 * is never true. A prefix longer than the surname cuts to the whole surname,
 * which cannot equal the longer prefix, so it correctly finds nothing.
 *
 * **The case-folding is ASCII-only, and that is a real limit, not an
 * oversight.** SQLite's `lower()` folds ASCII and leaves everything else
 * alone, so a household stored as `Ünsal` is not found by `ünsal`. Fixing it
 * properly means a `referee_surname_normalised` column lowered in TypeScript,
 * where `toLowerCase()` is Unicode-aware — the same shape as
 * `refereePostcodeNormalised` — which is a migration and a backfill, not
 * something to fake here. Until the charity says it matters, an accented
 * surname is matched case-sensitively and the three identifiers still find the
 * household.
 */
function surnameStartsWith(prefix: string): SQL {
  const lowered = prefix.toLowerCase();
  return sql`lower(substr(${referrals.refereeSurname}, 1, length(${lowered}))) = ${lowered}`;
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

    /**
     * `POST /referrals/search`'s count, unbounded — see `searchReferrals`
     * below for why it must not be capped.
     */
    async countSearchResults(
      fields: MatchableFields,
      surnamePrefix: string | null,
    ): Promise<number> {
      const rows = await db
        .select({ total: count() })
        .from(referrals)
        .where(referralSearchPredicate(fields, surnamePrefix));
      return expectAtMostOne(rows)?.total ?? 0;
    },

    /**
     * `POST /referrals/search`'s rows, newest session first and **capped at
     * `REFERRAL_SEARCH_LIMIT`** — the same shape as
     * `listRepeatReferrals`/`countRepeatReferrals` above: the count comes
     * from `countSearchResults`, is not capped, and a list shorter than the
     * count is how an administrator is told a postcode belongs to a hostel.
     */
    async searchReferrals(
      fields: MatchableFields,
      surnamePrefix: string | null,
    ): Promise<ReferralSearchCandidate[]> {
      return (
        db
          .select({
            id: referrals.id,
            refereeFirstName: referrals.refereeFirstName,
            refereeSurname: referrals.refereeSurname,
            refereePostcode: referrals.refereePostcode,
            refereePhone: referrals.refereePhone,
            sessionDate: sessions.sessionDate,
            status: referrals.status,
            reasonId: referrals.reasonId,
            referrerName: referrals.referrerName,
            answersJson: referrals.answersJson,
          })
          .from(referrals)
          .innerJoin(sessions, eq(sessions.id, referrals.sessionId))
          .where(referralSearchPredicate(fields, surnamePrefix))
          // `id` breaks the tie so the fifty are the same fifty every time. A
          // hostel postcode is exactly where the cap bites and exactly where
          // dozens of referrals share one session date, so without it "50 of
          // 200" could be a different fifty on each identical request.
          .orderBy(desc(sessions.sessionDate), asc(referrals.id))
          .limit(REFERRAL_SEARCH_LIMIT)
      );
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
