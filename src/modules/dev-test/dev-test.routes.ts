import { Hono, type Context } from 'hono';
import type { AppConfig } from '../../config/env.ts';
import type { Actor } from '../../core/actor.ts';
import { UnauthorizedError } from '../../core/errors.ts';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import type { AppEnv } from '../../http/types.ts';
import { parseJsonBody } from '../../http/validate.ts';
import { createReferralsRepository } from '../referrals/referrals.repository.ts';
import { createReferrersRepository } from '../referrers/referrers.repository.ts';
import { createSessionsRepository } from '../sessions/sessions.repository.ts';
import { createDevTestImportsRepository } from './dev-test-imports.repository.ts';
import { createDevTestImportsService } from './dev-test-imports.service.ts';
import { toReferralImportResponse } from './dev-test.mapper.ts';
import { referralImportRequestSchema } from './dev-test.schema.ts';

/**
 * Bulk-loads prepared, anonymised referral scenarios straight to `active`,
 * for the client's own dev/test automation to exercise pick-list generation
 * against. Never a real referral source — see `dev-test-imports.service.ts`.
 *
 * **Registered only outside production.** Built against `config` so the
 * route can be omitted entirely rather than guarded, the same as
 * `/auth/dev-login` — a route that does not exist cannot be reached by a
 * middleware-ordering mistake, and a misconfigured production deployment has
 * nothing here to reach in the first place.
 *
 * **`referrerEmail` must end `example.test`, checked in `dev-test.schema.ts`
 * regardless of the environment gate.** That check is defence-in-depth, not
 * the only protection — the route being absent in production is the real
 * one, this is what stops a real address landing here in dev or test too.
 */
export function devTestImportRoutes(config: AppConfig): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  if (!config.isProduction) {
    routes.post('/dev-test/referral-imports', requireAuth, requireRole('admin'), async (c) => {
      const body = await parseJsonBody(c, referralImportRequestSchema);
      const result = await serviceFor(c).importReferrals(body, actorOf(c));
      return c.json(toReferralImportResponse(result));
    });
  }

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
  return createDevTestImportsService({
    db,
    repository: createDevTestImportsRepository(db),
    referrals: createReferralsRepository(db),
    sessions: createSessionsRepository(db),
    referrers: createReferrersRepository(db),
    clock: c.get('clock'),
    logger: c.get('logger'),
  });
}
