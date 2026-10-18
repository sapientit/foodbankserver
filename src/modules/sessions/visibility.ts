/**
 * Which sessions a caller may see at all.
 *
 * A team lead cannot see a closed session — confirmed or cancelled — by any
 * route (`INITIAL_SPEC1.txt`, the session list under `#Login`). There is
 * nothing left for them to do with one, so it is only ever a whole session's
 * names, addresses and referral reasons on a screen with no job attached.
 *
 * **Status only, never the date.** A session whose day has gone by unconfirmed
 * is still the team lead's to mark and confirm. That is deliberately narrower
 * than `sms.mapper.ts`'s `isSessionClosed`, which adds the date because it
 * answers a different question: whose job an unread reply is.
 *
 * Pure and shared, because the session reaches most team-lead routes through
 * another module's repository rather than the sessions service; every one of
 * them calls this rather than restating the rule.
 */

import { isAdmin, type Actor } from '../../core/actor.ts';
import { NotFoundError } from '../../core/errors.ts';
import type { SessionStatus } from '../../db/schema/sessions.ts';

export const SESSION_STATUSES_HIDDEN_FROM_TEAM_LEADS = [
  'confirmed',
  'cancelled',
] as const satisfies readonly SessionStatus[];

export function canSeeSession(actor: Actor, session: { readonly status: SessionStatus }): boolean {
  if (isAdmin(actor)) return true;
  return !SESSION_STATUSES_HIDDEN_FROM_TEAM_LEADS.some((hidden) => hidden === session.status);
}

/**
 * Refuses a session the caller may not see as though it did not exist.
 *
 * `404`, not `403`, for the same reason as a rejected referral: a refusal that
 * says "forbidden" tells a team lead the session is there. `message` lets a
 * caller that reached the session through a pick list, parcel or referral
 * refuse in that resource's own words, so the 404 reads the same as a wrong id.
 */
export function assertCanSeeSession(
  actor: Actor,
  session: { readonly status: SessionStatus },
  message = 'Session not found',
): void {
  if (!canSeeSession(actor, session)) {
    throw new NotFoundError(message);
  }
}
