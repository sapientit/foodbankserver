import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './types.ts';

/**
 * CORS for the separate React frontend.
 *
 * Deliberately an **allowlist, never a wildcard**. `Access-Control-Allow-Origin: *`
 * cannot be combined with credentials, and this API sends a refresh cookie —
 * so a wildcard would either break authentication or, worse, be "fixed" later
 * by reflecting whatever `Origin` arrives, which is the same as no policy at
 * all.
 *
 * With no origins configured nothing is emitted, which is correct for a
 * same-origin deployment (frontend served as Workers static assets) and is the
 * safest default if someone forgets to configure it.
 */
export const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const allowed = c.get('config').allowedOrigins;
  const origin = c.req.header('origin');
  const isAllowed = origin !== undefined && allowed.includes(origin);

  if (isAllowed) {
    c.header('access-control-allow-origin', origin);
    c.header('access-control-allow-credentials', 'true');
    // The response varies by Origin, so a shared cache must not serve one
    // origin's response to another.
    c.header('vary', 'Origin');
  }

  if (c.req.method !== 'OPTIONS') {
    await next();
    return;
  }

  if (!isAllowed) {
    // Refuse the preflight rather than answering it for an unknown origin.
    return c.body(null, 403);
  }

  c.header('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  c.header('access-control-allow-headers', 'authorization,content-type,cf-turnstile-response');
  c.header('access-control-max-age', '86400');
  return c.body(null, 204);
};
