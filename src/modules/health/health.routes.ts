import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { toSafeError } from '../../core/log.ts';
import type { AppEnv } from '../../http/types.ts';

export interface HealthResponse {
  readonly status: 'ok';
  /** The deployed commit, or `null` where none was stamped (local dev, CI's dry run). */
  readonly version: string | null;
}

export interface ReadyResponse {
  readonly status: 'ok' | 'degraded';
  readonly checks: { readonly database: 'ok' | 'failed' };
}

export function healthRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Liveness. Touches nothing downstream, so it stays up while D1 is not.
   * `version` is the git commit stamped at deploy time (see `config/env.ts`)
   * — a deploy script or a human can curl this after a deploy and compare it
   * against `git rev-parse HEAD` to confirm the edge picked up the release.
   */
  routes.get('/health', (c) => {
    return c.json<HealthResponse>({ status: 'ok', version: c.get('config').gitSha ?? null });
  });

  /** Readiness. Confirms the D1 binding actually answers. */
  routes.get('/ready', async (c) => {
    try {
      await c.get('db').run(sql`SELECT 1`);
    } catch (error) {
      c.get('logger').error('readiness check failed', { error: toSafeError(error) });
      return c.json<ReadyResponse>({ status: 'degraded', checks: { database: 'failed' } }, 503);
    }
    return c.json<ReadyResponse>({ status: 'ok', checks: { database: 'ok' } });
  });

  return routes;
}
