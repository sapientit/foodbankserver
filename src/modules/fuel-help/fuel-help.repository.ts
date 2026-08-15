import { and, asc, eq, gte } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { parcels, pickLists } from '../../db/schema/pick-lists.ts';
import { referrals, type Referral } from '../../db/schema/referrals.ts';
import { sessions, type Session } from '../../db/schema/sessions.ts';

/** One household, and the session they were actually fed at. */
export interface FuelHelpRow {
  readonly referral: Referral;
  readonly session: Session;
}

/**
 * The one query this module needs.
 *
 * **It owns none of these four tables and writes to none of them.** That is
 * the same arrangement `sms.repository.ts` has with `referrals` and
 * `sessions`: a module owns the queries it needs to answer its own question,
 * and never reaches into another module's repository to get them.
 *
 * ## Why the join runs through the parcel, not the referral
 *
 * `referrals.sessionId` and `pickLists.sessionId` can disagree. The spec says
 * the household "was given their parcel" at a session that "has been
 * confirmed" — which is the session the *parcel* sat on, not the one the
 * referral now points at.
 *
 * Moving no longer creates that disagreement: a referral whose parcel has an
 * outcome cannot be moved at all, and a move deletes the pending parcel on the
 * session being left. **The join must still run this way regardless**, because
 * referrals moved before that rule are still in the old state and this list
 * reaches back fourteen dates over exactly that data.
 *
 * So the path is `sessions → pick_lists → parcels → referrals`, and
 * **`referrals.sessionId` is never read here.** Following the referral instead
 * would put a household on the list under a session they were never fed at,
 * and drop one they were.
 *
 * ## Cost
 *
 * **One query whatever the row count**, against a budget of 50 per invocation.
 * Driving from `sessions` gives the planner the index built for this shape:
 * `idx_sessions_status_date` on `(status, session_date)` covers the selective
 * half of the WHERE clause, `pick_lists.session_id` is unique,
 * `idx_parcels_referral` leads on `pick_list_id`, and the last hop is a
 * primary key.
 *
 * ## Two filters that are deliberately absent
 *
 * There is **no filter on `referrals.status`**. The spec names four conditions
 * and a fifth would be re-deriving the requirement rather than implementing it.
 *
 * Note what that does *not* mean. It would be wrong to say a confirmed session
 * is sealed so a cancelled referral cannot appear: `assertOpenToChange` checks
 * the status of the session the referral **currently** points at, which is the
 * same asymmetry this join exists to route around. A household fed at session A
 * can be moved to unconfirmed session B, cancelled there, and then A confirmed —
 * leaving an `attended` parcel on a confirmed session behind a `cancelled`
 * referral, which this query returns.
 *
 * That is deliberate rather than overlooked. The household did receive the
 * parcel: stock moved, somebody handed it over, and cancelling the referral
 * afterwards does not un-feed them. Fuel help follows the parcel, so it follows
 * them too.
 *
 * There is **no filter on `piiPurgedAt`**. Retention is twelve months and this
 * window is fourteen days, so a purged row cannot reach the list. Filtering on
 * it would imply it could, and invite somebody to widen the window later
 * without noticing what that costs.
 */
export function createFuelHelpRepository(db: Database) {
  return {
    /** `earliestSessionDate` is an inclusive London `YYYY-MM-DD`. */
    async listFuelHelpSince(earliestSessionDate: string): Promise<FuelHelpRow[]> {
      return (
        db
          .select({ referral: referrals, session: sessions })
          .from(sessions)
          .innerJoin(pickLists, eq(pickLists.sessionId, sessions.id))
          .innerJoin(parcels, eq(parcels.pickListId, pickLists.id))
          .innerJoin(referrals, eq(referrals.id, parcels.referralId))
          .where(
            and(
              eq(sessions.status, 'confirmed'),
              gte(sessions.sessionDate, earliestSessionDate),
              eq(parcels.attendance, 'attended'),
              eq(referrals.needsFuelHelp, 1),
            ),
          )
          // Oldest session first, so whoever works through the list deals with
          // the households closest to dropping off the end. Ordered on the
          // derived instant rather than the wall-clock date, as every other
          // session query here is: two sessions can share a date, and this is a
          // total order where `sessionDate` alone is not.
          .orderBy(asc(sessions.startsAtUtc))
      );
    },
  };
}

export type FuelHelpRepository = ReturnType<typeof createFuelHelpRepository>;
