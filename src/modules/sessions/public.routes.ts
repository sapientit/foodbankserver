import { Hono } from 'hono';
import type { AppEnv } from '../../http/types.ts';
import { rateLimit } from '../../http/middleware/rate-limit.ts';
import { createSessionsRepository } from './sessions.repository.ts';
import { publicSessionWindow } from './public-window.ts';
import { toPublicSessionResponse, type PublicSessionResponse } from './sessions.mapper.ts';

/**
 * Unauthenticated. A referrer needs to see when they can send someone before
 * they have any credentials — the referral flow itself is unauthenticated too.
 *
 * Everything here must therefore be safe for the open internet: no personal
 * data, no operational detail, one query, and a fixed window that cannot be
 * widened by a parameter.
 *
 * The window's near end is the 16:00-the-day-before booking cutoff, which this
 * list is the only place that applies — see `public-window.ts`.
 */
export function publicSessionRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/sessions', rateLimit('PUBLIC_LIMITER'), async (c) => {
    const { fromUtc, toUtc } = publicSessionWindow(c.get('clock').nowIso());

    const availableSessions = await createSessionsRepository(c.get('db')).listPubliclyAvailable(
      fromUtc,
      toUtc,
    );

    return c.json<{ sessions: PublicSessionResponse[] }>({
      sessions: availableSessions.map(toPublicSessionResponse),
    });
  });

  return routes;
}
