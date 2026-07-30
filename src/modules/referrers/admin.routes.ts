import { Hono, type Context } from 'hono';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseJsonBody } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import { createReferrersRepository } from './referrers.repository.ts';
import { createReferrersService } from './referrers.service.ts';
import {
  authorisedReferrerInputSchema,
  authorisedReferrerPatchSchema,
  referralReasonInputSchema,
  referralReasonPatchSchema,
} from './referrers.schema.ts';
import { toAdminReferralReasonResponse, toAuthorisedReferrerResponse } from './referrers.mapper.ts';

/**
 * Admin-only. Who may refer and why people are referred are both policy
 * decisions — a team lead runs sessions, they do not set policy.
 *
 * The questions on the referral form are **not** here: the form is client
 * configuration, so there is nothing on the server to maintain.
 *
 * Middleware is attached per route, never via a wildcard `use`. See CLAUDE.md.
 */
export function referrerAdminRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const admins = [requireAuth, requireRole('admin')] as const;

  // ---- Authorised referrers ----

  routes.get('/authorised-referrers', ...admins, async (c) => {
    const rows = await referrersFor(c).list();
    return c.json({ authorisedReferrers: rows.map(toAuthorisedReferrerResponse) });
  });

  routes.post('/authorised-referrers', ...admins, async (c) => {
    const input = await parseJsonBody(c, authorisedReferrerInputSchema);
    const created = await referrersFor(c).create(input);

    c.get('logger').info('authorised a referrer', { code: created.matchType });
    return c.json({ id: created.id, matchValue: created.matchValue }, 201);
  });

  routes.patch('/authorised-referrers/:id', ...admins, async (c) => {
    // Booleans are destructured out rather than spread over: SQLite stores
    // them as 0/1, and spreading would leave `boolean` in the union.
    const { isActive, ...rest } = await parseJsonBody(c, authorisedReferrerPatchSchema);
    const updated = await referrersFor(c).update(c.req.param('id'), {
      ...rest,
      ...(isActive === undefined ? {} : { isActive: isActive ? 1 : 0 }),
    });

    return c.json({ id: updated.id, isActive: updated.isActive === 1 });
  });

  // ---- Referral reasons (the dropdown) ----

  routes.get('/referral-reasons', ...admins, async (c) => {
    const rows = await referrersFor(c).listReasons(false);
    return c.json({ referralReasons: rows.map(toAdminReferralReasonResponse) });
  });

  routes.post('/referral-reasons', ...admins, async (c) => {
    const input = await parseJsonBody(c, referralReasonInputSchema);
    const created = await referrersFor(c).createReason(input);

    return c.json(toAdminReferralReasonResponse(created), 201);
  });

  routes.patch('/referral-reasons/:id', ...admins, async (c) => {
    const { isActive, ...rest } = await parseJsonBody(c, referralReasonPatchSchema);
    const updated = await referrersFor(c).updateReason(c.req.param('id'), {
      ...rest,
      ...(isActive === undefined ? {} : { isActive: isActive ? 1 : 0 }),
    });

    return c.json(toAdminReferralReasonResponse(updated));
  });

  return routes;
}

function referrersFor(c: Context<AppEnv>) {
  return createReferrersService({
    repository: createReferrersRepository(c.get('db')),
    clock: c.get('clock'),
  });
}
