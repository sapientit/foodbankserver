import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppConfig } from '../../config/env.ts';
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../../config/constants.ts';
import { UnauthorizedError } from '../../core/errors.ts';
import type { AppEnv } from '../../http/types.ts';
import { requireAuth } from '../../http/middleware/require-auth.ts';
import { createAuthRepository } from './auth.repository.ts';
import { createAuthService, type IssuedTokens } from './auth.service.ts';
import type { TokenResponse } from './auth.schema.ts';
import { createDummyProvider } from './providers/dummy-provider.ts';

/**
 * Routes are built against a config so the dev-login route can be omitted
 * entirely rather than guarded. An unregistered route cannot be reached by a
 * middleware-ordering mistake; a guarded one can.
 */
export function authRoutes(config: AppConfig): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  if (config.authMode === 'dummy') {
    routes.post('/dev-login', async (c) => {
      const service = serviceFor(c);
      const tokens = await service.login(await c.req.json(), createDummyProvider());

      c.get('logger').info('dev login', { userId: tokens.user.id, actorRole: tokens.user.role });
      return respondWithTokens(c, tokens);
    });
  }

  routes.post('/refresh', async (c) => {
    const presented = getCookie(c, REFRESH_COOKIE_NAME);
    if (presented === undefined) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    return respondWithTokens(c, await serviceFor(c).rotate(presented));
  });

  routes.post('/logout', async (c) => {
    const presented = getCookie(c, REFRESH_COOKIE_NAME);
    if (presented !== undefined) {
      await serviceFor(c).logout(presented);
    }

    deleteCookie(c, REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    return c.body(null, 204);
  });

  routes.get('/me', requireAuth, (c) => {
    const actor = c.get('actor');
    if (actor === undefined) {
      throw new UnauthorizedError('Authentication required');
    }
    return c.json({ id: actor.userId, email: actor.email, role: actor.role });
  });

  return routes;
}

function serviceFor(c: Context<AppEnv>) {
  const db = c.get('db');
  return createAuthService({
    db,
    repository: createAuthRepository(db),
    clock: c.get('clock'),
    logger: c.get('logger'),
    jwtSecret: c.get('config').jwtSecret,
  });
}

/**
 * The refresh token goes in a cookie, not the body: it must never be readable
 * by JavaScript. `SameSite=Strict` plus a path scoped to the auth routes means
 * it is not attached to any domain request, so a CSRF against `/referrals`
 * cannot ride on it.
 *
 * The access token goes in the body, for the frontend to hold in memory only.
 */
function respondWithTokens(c: Context<AppEnv>, tokens: IssuedTokens): Response {
  setCookie(c, REFRESH_COOKIE_NAME, tokens.refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });

  return c.json<TokenResponse>({
    accessToken: tokens.accessToken,
    expiresAt: tokens.accessTokenExpiresAt,
    user: {
      id: tokens.user.id,
      email: tokens.user.email,
      displayName: tokens.user.displayName,
      role: tokens.user.role,
    },
  });
}
