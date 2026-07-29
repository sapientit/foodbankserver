import { Hono, type Context } from 'hono';
import { UnauthorizedError } from '../../core/errors.ts';
import { sha256Hex } from '../../core/crypto/tokens.ts';
import type { AppEnv } from '../../http/types.ts';
import { parseJsonBody, parseOptionalJsonBody } from '../../http/validate.ts';
import { rateLimit } from '../../http/middleware/rate-limit.ts';
import { requireTurnstile, TURNSTILE_HEADER } from '../security/turnstile.ts';
import { createFormsRepository } from '../forms/forms.repository.ts';
import { createFormsService } from '../forms/forms.service.ts';
import { createReferrersRepository } from '../referrers/referrers.repository.ts';
import { createReferrersService } from '../referrers/referrers.service.ts';
import { createSessionsRepository } from '../sessions/sessions.repository.ts';
import { createReferralsRepository } from './referrals.repository.ts';
import { createReferralsService } from './referrals.service.ts';
import {
  toReceiptResponse,
  toSelfServiceResponse,
  type ReferralReceiptResponse,
} from './referrals.mapper.ts';
import {
  cancelReferralSchema,
  referralSelfAmendSchema,
  referralSubmissionSchema,
} from './referrals.schema.ts';

export const REFERRAL_KEY_HEADER = 'x-referral-key';

/**
 * Unauthenticated referral routes.
 *
 * The submission endpoint is the most exposed surface in the system: an open
 * write that stores names and addresses. It needs rate limiting and Turnstile
 * before go-live — tracked in CLAUDE.md.
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
    const { referral, editKey, editKeyExpiresAt } = await serviceFor(c).submit(input);

    // The key appears in this response and nowhere else, ever.
    return c.json<ReferralReceiptResponse>(
      toReceiptResponse(referral, editKey, editKeyExpiresAt),
      201,
    );
  });

  routes.get('/referrals/:id', rateLimit('PUBLIC_LIMITER'), async (c) => {
    const referral = await serviceFor(c).authoriseByEditKey(c.req.param('id'), requireKey(c));
    return c.json(toSelfServiceResponse(referral));
  });

  routes.patch('/referrals/:id', rateLimit('PUBLIC_LIMITER'), async (c) => {
    const service = serviceFor(c);
    const key = requireKey(c);

    const referral = await service.authoriseByEditKey(c.req.param('id'), key);
    const input = await parseJsonBody(c, referralSelfAmendSchema);
    const updated = await service.applyAmendment(referral, input, {
      kind: 'referral_key',
      userId: null,
    });

    return c.json(toSelfServiceResponse(updated));
  });

  routes.delete('/referrals/:id', rateLimit('PUBLIC_LIMITER'), async (c) => {
    const service = serviceFor(c);
    const key = requireKey(c);

    const referral = await service.authoriseByEditKey(c.req.param('id'), key);
    await parseOptionalJsonBody(c, cancelReferralSchema);
    await service.withdraw(referral, await sha256Hex(key));

    return c.body(null, 204);
  });

  return routes;
}

/**
 * The key travels in a header, never a URL — query strings land in access logs
 * — and never a cookie, which would create a CSRF surface on an endpoint that
 * has no other authentication.
 */
function requireKey(c: Context<AppEnv>): string {
  const key = c.req.header(REFERRAL_KEY_HEADER);
  if (key === undefined || key.trim() === '') {
    throw new UnauthorizedError('This request needs the edit key returned when you referred');
  }
  return key.trim();
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
    forms: createFormsService({ db, repository: createFormsRepository(db), clock }),
  });
}
