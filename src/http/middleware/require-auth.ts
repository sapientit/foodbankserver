import type { MiddlewareHandler } from 'hono';
import type { Actor } from '../../core/actor.ts';
import { ForbiddenError, UnauthorizedError } from '../../core/errors.ts';
import type { UserRole } from '../../db/schema/users.ts';
import { verifyAccessToken } from '../../modules/auth/token.service.ts';
import type { AppEnv } from '../types.ts';

/**
 * Verifies the bearer access token and puts an `Actor` on the context.
 *
 * Costs zero database queries — the token is self-contained and signed. That
 * matters: on the free plan a Worker invocation gets 50 queries total, and
 * spending one per request on authentication would eat the budget the
 * pick-list endpoints need.
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization');
  if (header?.startsWith('Bearer ') !== true) {
    throw new UnauthorizedError('Authentication required');
  }

  const claims = await verifyAccessToken(
    header.slice('Bearer '.length).trim(),
    c.get('config').jwtSecret,
    c.get('clock'),
  );

  const actor: Actor = { userId: claims.sub, email: claims.email, role: claims.role };
  c.set('actor', actor);

  await next();
};

/**
 * Restricts a route to the given roles. Compose after `requireAuth`.
 *
 * Prefer naming roles explicitly at each route over inventing a hierarchy —
 * "team_lead is a lesser admin" stops being true the moment one permission
 * goes the other way, and there are only two roles.
 */
export function requireRole(...roles: readonly UserRole[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get('actor');
    if (actor === undefined) {
      throw new UnauthorizedError('Authentication required');
    }
    if (!roles.includes(actor.role)) {
      c.get('logger').info('rejected by role', { userId: actor.userId, actorRole: actor.role });
      throw new ForbiddenError('Not permitted');
    }
    await next();
  };
}
