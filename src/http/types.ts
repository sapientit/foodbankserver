import type { AppConfig } from '../config/env.ts';
import type { Actor } from '../core/actor.ts';
import type { Clock } from '../core/clock.ts';
import type { Logger } from '../core/log.ts';
import type { Database } from '../db/client.ts';

/** Cloudflare bindings declared in wrangler.jsonc. */
export interface Bindings {
  readonly DB: D1Database;
  readonly ENVIRONMENT: string;
  readonly LOG_LEVEL: string;
  readonly AUTH_MODE: string;
}

/**
 * Per-request values set by middleware.
 *
 * Handlers pull what they need out of here and pass plain values into
 * services. A service must never receive the Hono `Context` itself — that is
 * the same layering violation as a service importing `FastifyRequest` was.
 */
export interface Variables {
  readonly requestId: string;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Database;
  readonly clock: Clock;
  /**
   * Set by `requireAuth`. Optional because unauthenticated routes exist — the
   * public session list and referral submission both run without one.
   */
  readonly actor?: Actor;
}

export interface AppEnv {
  readonly Bindings: Bindings;
  readonly Variables: Variables;
}
