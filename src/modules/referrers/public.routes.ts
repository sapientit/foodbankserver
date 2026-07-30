import { Hono } from 'hono';
import type { AppEnv } from '../../http/types.ts';
import { parseJsonBody } from '../../http/validate.ts';
import { rateLimit } from '../../http/middleware/rate-limit.ts';
import { createReferrersRepository } from './referrers.repository.ts';
import { createReferrersService } from './referrers.service.ts';
import { referrerCheckSchema } from './referrers.schema.ts';
import { toReferralReasonResponse } from './referrers.mapper.ts';

/**
 * Unauthenticated. A referrer uses these before they have any credentials.
 *
 * The questions on the referral form are not served here — the form is client
 * configuration. The reason dropdown still is, because it is a maintained
 * lookup the referral itself points at by id.
 */
export function publicReferrerRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /** The reason dropdown, active options only, in display order. */
  routes.get('/referral-reasons', rateLimit('PUBLIC_LIMITER'), async (c) => {
    const reasons = await createReferrersRepository(c.get('db')).listReasons(true);
    return c.json({ referralReasons: reasons.map(toReferralReasonResponse) });
  });

  /**
   * Whether an address may refer.
   *
   * Returns the organisation name so the form can pre-fill it. It reveals
   * which organisations are authorised, which is organisational rather than
   * personal information — but it is still an enumeration surface, hence the
   * rate limiting.
   */
  routes.post('/referrers/check', rateLimit('PUBLIC_LIMITER'), async (c) => {
    const { email } = await parseJsonBody(c, referrerCheckSchema);

    const result = await createReferrersService({
      repository: createReferrersRepository(c.get('db')),
      clock: c.get('clock'),
    }).checkAuthorisation(email);

    return c.json({
      authorised: result.authorised,
      organisationName: result.organisationName,
    });
  });

  return routes;
}
