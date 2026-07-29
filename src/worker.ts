import type { Hono } from 'hono';
import { buildApp } from './app.ts';
import { loadConfig } from './config/env.ts';
import { systemClock } from './core/clock.ts';
import { createLogger, toSafeError } from './core/log.ts';
import { createDatabase } from './db/client.ts';
import { runScheduledJobs } from './modules/jobs/run-scheduled.ts';
import type { AppEnv, Bindings } from './http/types.ts';

/**
 * The Worker entrypoint.
 *
 * The app is built once per isolate rather than per request — construction
 * walks the whole route table — but not until the first request, because
 * bindings are only available then and route registration depends on them.
 */
let app: Hono<AppEnv> | undefined;

function getApp(env: Bindings): Hono<AppEnv> {
  app ??= buildApp(loadConfig(env));
  return app;
}

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response> {
    return getApp(env).fetch(request, env, ctx);
  },

  /**
   * Cron entrypoint. One trigger runs every scheduled job, branching on
   * `controller.cron`, because the free plan allows only five triggers per
   * account and there is no reason to spend more than one here.
   */
  async scheduled(controller: ScheduledController, env: Bindings, _ctx: ExecutionContext) {
    const config = loadConfig(env);
    const logger = createLogger(config.logLevel, { jobName: 'scheduled' });

    try {
      logger.info('scheduled run started', { reason: controller.cron });

      const result = await runScheduledJobs({
        db: createDatabase(env.DB),
        clock: systemClock,
        logger,
        piiRetentionDays: config.piiRetentionDays,
      });

      logger.info('scheduled run finished', { count: result.sessionsCreated });
    } catch (error) {
      // Rethrowing marks the invocation failed so it is visible in
      // observability rather than silently swallowed.
      logger.error('scheduled run failed', { error: toSafeError(error) });
      throw error;
    }
  },
} satisfies ExportedHandler<Bindings>;
