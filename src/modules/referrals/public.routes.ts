import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../http/types.ts';
import { parseJsonBody } from '../../http/validate.ts';
import { rateLimit } from '../../http/middleware/rate-limit.ts';
import { requireTurnstile, TURNSTILE_HEADER } from '../security/turnstile.ts';
import { createReferrersRepository } from '../referrers/referrers.repository.ts';
import { createReferrersService } from '../referrers/referrers.service.ts';
import { createSessionsRepository } from '../sessions/sessions.repository.ts';
import { createReferralsRepository } from './referrals.repository.ts';
import { createReferralsService } from './referrals.service.ts';
import { toReceiptResponse, type ReferralReceiptResponse } from './referrals.mapper.ts';
import { referralSubmissionSchema } from './referrals.schema.ts';

/**
 * The unauthenticated referral route. There is exactly one.
 *
 * Submission is the most exposed surface in the system: an open write that
 * stores names and addresses. Rate limiting and Turnstile are both applied
 * below; Turnstile is inert until a secret is configured, which `config/env.ts`
 * allows only outside production. See STATUS.md.
 *
 * There is no self-service read, amend or withdraw. The fifteen-minute window
 * those served has been withdrawn: a referrer confirms what they sent on the
 * spot and phones the food bank if it needs changing, which is what they
 * already did once the window closed.
 */
export function publicReferralRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/referrals', rateLimit('REFERRAL_LIMITER'), async (c) => {
    // Bot check before anything is parsed or written. This is the most exposed
    // endpoint in the system: an open write that stores names and addresses.
    await requireTurnstile({
      secret: c.get('config').turnstileSecret,
      token: c.req.header(TURNSTILE_HEADER),
      remoteIp: c.req.header('cf-connecting-ip'),
      requestId: c.get('requestId'),
      logger: c.get('logger'),
    });

    const input = await parseJsonBody(c, referralSubmissionSchema);
    const referral = await serviceFor(c).submit(input);

    // 201 whether or not the address was recognised. An unrecognised referrer
    // is not turned away — the referral waits for an administrator, and
    // `status` is how the confirmation screen says so.
    return c.json<ReferralReceiptResponse>(toReceiptResponse(referral), 201);
  });

  return routes;
}

function serviceFor(c: Context<AppEnv>) {
  const db = c.get('db');
  const clock = c.get('clock');
  const referrers = createReferrersRepository(db);

  return createReferralsService({
    db,
    clock,
    logger: c.get('logger'),
    repository: createReferralsRepository(db),
    sessions: createSessionsRepository(db),
    referrers,
    referrersService: createReferrersService({ repository: referrers, clock }),
  });
}
