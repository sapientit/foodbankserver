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
import { toReferralResponse, type ReferralResponse } from './referrals.mapper.ts';
import {
  cancelReferralSchema,
  referralAdminAmendSchema,
  referralListQuerySchema,
  reviewReferralSchema,
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

  routes.get('/referrals/:id', ...readers, async (c) => {
    const actor = actorOf(c);
    const referral = await serviceFor(c).viewReferral(c.req.param('id'), actor);
    return c.json(toReferralResponse(referral, actor));
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
   * The two halves of reviewing a referral that arrived from an unrecognised
   * address. Both refuse anything that is not waiting to be reviewed.
   *
   * Written out rather than looped because `check:openapi` reads the routes
   * out of this file as text, and a route it cannot see is a route the contract
   * stops being checked against.
   */
  routes.post('/referrals/:id/accept', ...admins, async (c) =>
    review(c, c.req.param('id'), 'active'),
  );
  routes.post('/referrals/:id/reject', ...admins, async (c) =>
    review(c, c.req.param('id'), 'rejected'),
  );

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

async function review(c: Context<AppEnv>, id: string, outcome: 'active' | 'rejected') {
  const service = serviceFor(c);
  const actor = actorOf(c);

  const { comment } = await parseOptionalJsonBody(c, reviewReferralSchema);
  // No read first: the "still pending" guard is in the UPDATE itself, so a
  // read here would only add a query and a race window. See the service.
  const reviewed = await service.review(id, outcome, comment ?? null, actor);

  return c.json(toReferralResponse(reviewed, actor));
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
