import { Hono } from 'hono';
import { PUBLIC_SESSION_WINDOW_DAYS } from '../../config/constants.ts';
import { addDays } from '../../core/time/plain-date.ts';
import { instantToLondonWallClock, londonWallClockToInstant } from '../../core/time/london.ts';
import type { AppEnv } from '../../http/types.ts';
import { rateLimit } from '../../http/middleware/rate-limit.ts';
import { createSessionsRepository } from './sessions.repository.ts';
import { toPublicSessionResponse, type PublicSessionResponse } from './sessions.mapper.ts';

/**
 * Unauthenticated. A referrer needs to see when they can send someone before
 * they have any credentials — the referral flow itself is unauthenticated too.
 *
 * Everything here must therefore be safe for the open internet: no personal
 * data, no operational detail, one query, and a fixed window that cannot be
 * widened by a parameter.
 */
export function publicSessionRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/sessions', rateLimit('PUBLIC_LIMITER'), async (c) => {
    const clock = c.get('clock');
    const today = instantToLondonWallClock(clock.nowIso()).date;

    // Window boundaries as instants, since that is what the rows are indexed
    // on. From the start of today, to the end of the last day in the window.
    const fromUtc = londonWallClockToInstant(today, '00:00');
    const toUtc = londonWallClockToInstant(addDays(today, PUBLIC_SESSION_WINDOW_DAYS), '23:59');

    const sessions = await createSessionsRepository(c.get('db')).listPubliclyAvailable(
      fromUtc,
      toUtc,
    );

    return c.json<{ sessions: PublicSessionResponse[] }>({
      sessions: sessions.map(toPublicSessionResponse),
    });
  });

  return routes;
}
