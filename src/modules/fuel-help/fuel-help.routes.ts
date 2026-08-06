import { Hono, type Context } from 'hono';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import type { AppEnv } from '../../http/types.ts';
import type { FuelHelpHousehold } from './fuel-help.mapper.ts';
import { createFuelHelpRepository } from './fuel-help.repository.ts';
import { createFuelHelpService } from './fuel-help.service.ts';

/**
 * The fuel administrator's whole surface: this one route, plus `GET /auth/me`.
 *
 * Roles are named explicitly per route, as everywhere else. **`fuel_admin` is
 * not a lesser anything** and must never be folded into a hierarchy — it is a
 * boundary, and the boundary is the feature. An administrator is admitted too,
 * so the charity is not locked out of its own report when the person who
 * normally runs it is away or their account has been made inactive. A team
 * leader is not: this is not something that happens on the day.
 *
 * **No `routes.use('*', ...)`.** This sub-app shares the `/api/v1` prefix, so
 * a wildcard `use` here would apply to every path under that prefix rather
 * than to this module's routes — turning unmatched paths into 401s and
 * silently demanding a token on any public route mounted after it. See
 * `.claude/rules/authentication.md` and `test/route-mounting.test.ts`.
 */
export function fuelHelpRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  const fuelReaders = [requireAuth, requireRole('admin', 'fuel_admin')] as const;

  routes.get('/fuel-help-list', ...fuelReaders, async (c) => {
    const households = await serviceFor(c).list();

    return c.json<{ households: FuelHelpHousehold[] }>({ households });
  });

  return routes;
}

function serviceFor(c: Context<AppEnv>) {
  return createFuelHelpService({
    repository: createFuelHelpRepository(c.get('db')),
    clock: c.get('clock'),
  });
}
