import { Hono } from 'hono';
import { rateLimit } from '../../http/middleware/rate-limit.ts';
import type { AppEnv } from '../../http/types.ts';
import {
  toPublicQuestionnaireResponse,
  type PublicQuestionnaireResponse,
} from './configuration-releases.mapper.ts';
import { serviceFor } from './configuration-releases.routes.ts';

/**
 * The questionnaire of the release in use, and never its rules —
 * `INITIAL_SPEC1.txt`, `#referral`. Unauthenticated: the referral form loads
 * before a referrer has any credentials, the same as the public sessions and
 * referrers routes.
 */
export function publicConfigurationReleaseRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/questionnaire', rateLimit('PUBLIC_LIMITER'), async (c) => {
    const release = await serviceFor(c).current();
    return c.json<PublicQuestionnaireResponse>(toPublicQuestionnaireResponse(release));
  });

  return routes;
}
