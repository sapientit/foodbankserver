import type { MiddlewareHandler } from 'hono';
import { AppError } from '../../core/errors.ts';
import type { AppEnv } from '../types.ts';

/**
 * Too many requests. Not in the shared error taxonomy because 429 is a
 * transport concern rather than a domain outcome.
 */
export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests. Please wait a moment and try again.') {
    super('BAD_REQUEST', 429, message);
  }
}

/**
 * Rate limiting for the unauthenticated surface.
 *
 * Uses Cloudflare's Rate Limiting binding, which needs no npm dependency and
 * no state of our own. Keyed on the client IP: the referral endpoint has no
 * account to key on, which is exactly why it needs this.
 *
 * **The binding is optional.** It does not exist in the test runner or in a
 * plain `wrangler dev`, and a missing binding must not take the whole API down
 * — so an absent limiter is skipped. `config/env.ts` is where things are made
 * mandatory for production; this is a defence, not a gate.
 */
export function rateLimit(
  bindingName: 'REFERRAL_LIMITER' | 'PUBLIC_LIMITER',
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const limiter = (c.env as unknown as Record<string, RateLimit | undefined>)[bindingName];

    if (limiter !== undefined) {
      const { success } = await limiter.limit({ key: clientKey(c.req.raw) });

      if (!success) {
        c.get('logger').warn('rate limited', { path: new URL(c.req.url).pathname });
        throw new RateLimitedError();
      }
    }

    await next();
  };
}

/**
 * The key to count against.
 *
 * `cf-connecting-ip` is set by Cloudflare and cannot be spoofed by the client
 * — unlike `x-forwarded-for`, which must never be trusted here. Without it
 * (local dev) everything shares one bucket, which is harmless.
 */
function clientKey(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown-client';
}
