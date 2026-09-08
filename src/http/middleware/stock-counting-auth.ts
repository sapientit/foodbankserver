import type { MiddlewareHandler } from 'hono';
import { volunteerCodeServiceFrom } from '../../modules/stock/volunteer-code.service.ts';
import type { AppEnv } from '../types.ts';
import { requireAuth, requireRole } from './require-auth.ts';

const VOLUNTEER_CODE_HEADER = 'x-volunteer-code';

/**
 * The stock take, and only the stock take, is reachable two ways: by a
 * signed-in admin or team lead, or by a volunteer holding a code a team lead
 * handed out (see `INITIAL_SPEC1.txt`, #Stock maintenance). Everything else on
 * the stock routes — the item list, corrections, validation — stays signed-in
 * only, enforced by this middleware's *absence* from those routes' guards.
 *
 * A valid code sets `volunteerCode` on the context and nothing else: it never
 * produces an `actor`, so a handler that reads `actor` without also accepting
 * `volunteerCode` is closed to a code by construction. When no code is
 * presented this is exactly `requireAuth` then `requireRole('admin',
 * 'team_lead')`.
 *
 * **A present `X-Volunteer-Code` header wins outright** — the request is
 * treated as a volunteer-code request and is authenticated as one or refused,
 * even if a bearer token is also attached. That is deliberate: the counting
 * screen runs on a device that never signs in, so the only way both headers
 * arrive together is a client bug, and quietly preferring the token would hide
 * it. A blank header is treated as absent.
 *
 * One D1 query per code-authenticated request, which the stateless JWT path
 * deliberately avoids — but the stock-take routes are low-frequency (a page
 * save every few minutes), not the pick-list path the query budget guards,
 * and the lookup buys a code that stops working the instant it expires.
 */
export const stockCountingAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const presented = c.req.header(VOLUNTEER_CODE_HEADER);

  if (presented !== undefined && presented.trim() !== '') {
    const actor = await volunteerCodeServiceFrom(c.get('db'), c.get('clock')).authenticate(
      presented,
    );
    c.set('volunteerCode', actor);
    c.get('logger').info('authenticated a stock-take volunteer code', {
      userId: actor.createdByUserId,
    });
    await next();
    return;
  }

  await requireAuth(c, async () => {
    await requireRole('admin', 'team_lead')(c, next);
  });
};
