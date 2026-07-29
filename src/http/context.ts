import type { MiddlewareHandler } from 'hono';
import { loadConfig } from '../config/env.ts';
import { systemClock, type Clock } from '../core/clock.ts';
import { createLogger } from '../core/log.ts';
import { createDatabase } from '../db/client.ts';
import type { AppEnv } from './types.ts';

export interface ContextOptions {
  /** Overridden in tests so time-dependent behaviour is deterministic. */
  readonly clock?: Clock;
}

/**
 * Establishes per-request context: request id, validated config, database
 * handle, clock and a logger scoped to this request.
 *
 * Runs before everything else, so `c.get('logger')` is always safe inside a
 * handler — including in the error handler.
 */
export function requestContext(options: ContextOptions = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
    const base = { requestId, method: c.req.method, path: new URL(c.req.url).pathname };

    // Identity and a logger are established BEFORE anything that can fail, so
    // the error handler can rely on them unconditionally. `loadConfig` throws
    // on an invalid deployment — AUTH_MODE=dummy in production — and that
    // failure still has to produce a properly structured 500.
    c.set('requestId', requestId);
    c.set('logger', createLogger('error', base));
    c.header('x-request-id', requestId);

    const config = loadConfig(c.env);

    c.set('config', config);
    c.set('clock', options.clock ?? systemClock);
    c.set('db', createDatabase(c.env.DB));
    c.set('logger', createLogger(config.logLevel, base));

    await next();
  };
}

/**
 * Baseline security headers.
 *
 * This is a JSON API with no browser-rendered surface of its own, so the CSP
 * is maximally restrictive: nothing should ever be loaded from a response.
 */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  c.header('x-frame-options', 'DENY');
  c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  if (c.get('config').isProduction) {
    c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
};
