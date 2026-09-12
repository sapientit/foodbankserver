import { Hono, type Context } from 'hono';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseOrThrow } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import { createPlatformStatsRepository } from './platform-stats.repository.ts';
import { createPlatformStatsService } from './platform-stats.service.ts';
import {
  toAlertSummaryResponse,
  toUsageReportResponse,
  type AlertSummaryResponse,
  type UsageReportResponse,
} from './platform-stats.mapper.ts';
import { usageReportQuerySchema } from './platform-stats.schema.ts';

/**
 * Reports on this deployment's own Cloudflare usage against the free plan's
 * caps — see `INITIAL_SPEC1.txt`, `#Platform usage monitoring`.
 *
 * Admin only, throughout: this is about running the system, not about the
 * food bank's own work, so a team lead or fuel administrator has no reason
 * to see it.
 */
export function platformStatsRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  const admins = [requireAuth, requireRole('admin')] as const;

  routes.get('/platform-stats/usage', ...admins, async (c) => {
    const query = parseOrThrow(usageReportQuerySchema, {
      from: c.req.query('from'),
      to: c.req.query('to'),
    });

    const days = await serviceFor(c).getUsageReport(query.from, query.to);
    return c.json<UsageReportResponse>(toUsageReportResponse(days));
  });

  routes.get('/platform-stats/usage/alert-summary', ...admins, async (c) => {
    const summary = await serviceFor(c).getAlertSummary();
    return c.json<AlertSummaryResponse>(toAlertSummaryResponse(summary));
  });

  return routes;
}

function serviceFor(c: Context<AppEnv>) {
  return createPlatformStatsService({
    repository: createPlatformStatsRepository(c.get('db')),
    clock: c.get('clock'),
  });
}
