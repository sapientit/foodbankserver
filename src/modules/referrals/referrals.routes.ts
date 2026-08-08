import { Hono, type Context } from 'hono';
import { UnauthorizedError } from '../../core/errors.ts';
import type { Actor } from '../../core/actor.ts';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseJsonBody, parseOptionalJsonBody, parseOrThrow } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import { createReferrersRepository } from '../referrers/referrers.repository.ts';
import { createReferrersService } from '../referrers/referrers.service.ts';
import { createSessionsRepository } from '../sessions/sessions.repository.ts';
import { createReferralsRepository } from './referrals.repository.ts';
import { createReferralsService } from './referrals.service.ts';
import {
  toReferralResponse,
  toRepeatReferralListResponse,
  toRepeatReferralSummary,
  type ListenerSheetHousehold,
  type ReferralResponse,
  type RepeatReferralListResponse,
} from './referrals.mapper.ts';
import {
  acceptReferralSchema,
  cancelReferralSchema,
  referralAdminAmendSchema,
  referralListQuerySchema,
  rejectReferralSchema,
} from './referrals.schema.ts';

/**
 * Reads are open to any account — a team lead needs the list to run a session,
 * and the mapper withholds the reason and the review comment from them. Writes,
 * including the review decision, are admin-only.
 */
export function referralRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const readers = [requireAuth, requireRole('admin', 'team_lead')] as const;
  const admins = [requireAuth, requireRole('admin')] as const;

  routes.get('/referrals', ...readers, async (c) => {
    const query = parseOrThrow(referralListQuerySchema, {
      sessionId: c.req.query('sessionId'),
      status: c.req.query('status'),
    });

    const actor = actorOf(c);
    const referrals = await serviceFor(c).listReferrals(query, actor);

    return c.json<{ referrals: ReferralResponse[] }>({
      referrals: referrals.map((referral) => toReferralResponse(referral, actor)),
    });
  });

  /**
   * The listener sheet: one sheet for the session, every household on it.
   *
   * Session-scoped rather than under `/referrals` because it is a thing handed
   * to a volunteer on the day, not a view of the referral list. Open to a team
   * leader, and **the only place a team leader is given the reason for
   * referral** — see `toListenerSheetHousehold` for what that costs and why it
   * is narrow.
   */
  routes.get('/sessions/:sessionId/listener-sheet', ...readers, async (c) => {
    const sessionId = c.req.param('sessionId');
    const households = await serviceFor(c).listenerSheet(sessionId);

    return c.json<{ sessionId: string; households: ListenerSheetHousehold[] }>({
      sessionId,
      households,
    });
  });

  routes.get('/referrals/:id', ...readers, async (c) => {
    const actor = actorOf(c);
    const service = serviceFor(c);
    const referral = await service.viewReferral(c.req.param('id'), actor);

    // Admin only, and only then: a team lead's read costs no extra query.
    const repeatReferrals =
      actor.role === 'admin'
        ? toRepeatReferralSummary(await service.repeatReferralSummary(referral))
        : undefined;

    return c.json(toReferralResponse(referral, actor, repeatReferrals));
  });

  /**
   * The button behind the summary above: this household's referrals from the
   * last twelve months, each shown in full — capped at the fifty most recent,
   * while `count` stays the true total.
   *
   * Admin only, and more sensitive than the summary — it carries another
   * household's name, address, phone number and date of birth, which is why
   * it is its own route rather than a field on the one above. Nothing fetches
   * it until an administrator presses the button.
   */
  routes.get('/referrals/:id/repeat-referrals', ...admins, async (c) => {
    const result = await serviceFor(c).listRepeatReferralsFor(c.req.param('id'));
    return c.json<RepeatReferralListResponse>(toRepeatReferralListResponse(result));
  });

  routes.patch('/referrals/:id', ...admins, async (c) => {
    const service = serviceFor(c);
    const actor = actorOf(c);

    const { sessionId, acknowledgeOverCapacity, ...amendment } = await parseJsonBody(
      c,
      referralAdminAmendSchema,
    );

    let referral = await service.getReferral(c.req.param('id'));
    if (sessionId !== undefined) {
      referral = await service.move(referral, sessionId, acknowledgeOverCapacity, actor);
    }
    if (Object.keys(amendment).length > 0) {
      referral = await service.applyAmendment(referral, amendment, {
        kind: 'user',
        userId: actor.userId,
      });
    }

    return c.json(toReferralResponse(referral, actor));
  });

  /**
   * The two halves of deciding a referral that arrived from an unrecognised
   * address. Both refuse anything that is not waiting to be reviewed.
   *
   * Accepting takes an optional `authoriseReferrer`, which is the second accept
   * button: let this one through *and* add the referrer's address to the
   * authorised list so the next one is not held up. Rejecting does not, which
   * is why the two bodies have separate schemas rather than one with a field
   * that is meaningless on half of it.
   *
   * Written out rather than looped because `check:openapi` reads the routes
   * out of this file as text, and a route it cannot see is a route the contract
   * stops being checked against.
   */
  routes.post('/referrals/:id/accept', ...admins, async (c) => {
    const { comment, authoriseReferrer } = await parseOptionalJsonBody(c, acceptReferralSchema);
    const actor = actorOf(c);
    const accepted = await serviceFor(c).review(
      c.req.param('id'),
      'active',
      comment ?? null,
      actor,
      authoriseReferrer,
    );

    return c.json(toReferralResponse(accepted, actor));
  });

  routes.post('/referrals/:id/reject', ...admins, async (c) => {
    const { comment } = await parseOptionalJsonBody(c, rejectReferralSchema);
    const actor = actorOf(c);
    // No read first: the "still pending" guard is in the UPDATE itself, so a
    // read here would only add a query and a race window. See the service.
    const rejected = await serviceFor(c).review(
      c.req.param('id'),
      'rejected',
      comment ?? null,
      actor,
    );

    return c.json(toReferralResponse(rejected, actor));
  });

  /**
   * The administrator has read this referral through.
   *
   * A separate pass from accepting one: every referral is meant to be read,
   * including the ones nothing held up, and this is what makes "which has
   * nobody looked at yet?" answerable. Only an `active` referral can be marked;
   * the guard is in the statement, as it is for the decision above.
   */
  routes.post('/referrals/:id/review', ...admins, async (c) => {
    const actor = actorOf(c);
    const reviewed = await serviceFor(c).markReviewed(c.req.param('id'), actor);
    return c.json(toReferralResponse(reviewed, actor));
  });

  routes.post('/referrals/:id/cancel', ...admins, async (c) => {
    const service = serviceFor(c);
    const actor = actorOf(c);

    const { reason } = await parseOptionalJsonBody(c, cancelReferralSchema);
    const referral = await service.getReferral(c.req.param('id'));
    const cancelled = await service.cancel(referral, reason ?? null, {
      kind: 'user',
      userId: actor.userId,
    });

    return c.json(toReferralResponse(cancelled, actor));
  });

  return routes;
}

function actorOf(c: Context<AppEnv>): Actor {
  const actor = c.get('actor');
  if (actor === undefined) {
    throw new UnauthorizedError('Authentication required');
  }
  return actor;
}

function serviceFor(c: Context<AppEnv>) {
  const db = c.get('db');
  const clock = c.get('clock');
  const referrers = createReferrersRepository(db);

  return createReferralsService({
    db,
    clock,
    logger: c.get('logger'),
    repository: createReferralsRepository(db),
    sessions: createSessionsRepository(db),
    referrers,
    referrersService: createReferrersService({ repository: referrers, clock }),
  });
}
