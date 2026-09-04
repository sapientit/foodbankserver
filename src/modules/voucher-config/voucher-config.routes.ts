import { Hono, type Context } from 'hono';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseJsonBody } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import type { VoucherConfigRow } from '../../db/schema/voucher-config.ts';
import { createVoucherConfigRepository } from './voucher-config.repository.ts';
import { voucherConfigSchema } from './voucher-config.schema.ts';
import { createVoucherConfigService } from './voucher-config.service.ts';

/**
 * The Christmas-voucher date range — `INITIAL_SPEC1.txt`, `#Christmas
 * voucher and first-time selection`. Administrator Master Data, admin-only
 * both ways: nobody else needs the raw range, only the derived instruction
 * `GET /pick-lists/{id}/print` already carries.
 */
export function voucherConfigRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const admins = [requireAuth, requireRole('admin')] as const;

  routes.get('/voucher-config', ...admins, async (c) => {
    const config = await serviceFor(c).getConfig();
    return c.json(toVoucherConfigResponse(config));
  });

  /** Saved whole, never one date at a time. */
  routes.put('/voucher-config', ...admins, async (c) => {
    const input = await parseJsonBody(c, voucherConfigSchema);
    const saved = await serviceFor(c).saveConfig(input);

    c.get('logger').info('saved the voucher date range');
    return c.json(toVoucherConfigResponse(saved));
  });

  return routes;
}

function toVoucherConfigResponse(config: VoucherConfigRow | undefined) {
  return {
    startDate: config?.startDate ?? null,
    endDate: config?.endDate ?? null,
  };
}

function serviceFor(c: Context<AppEnv>) {
  return createVoucherConfigService({
    repository: createVoucherConfigRepository(c.get('db')),
    clock: c.get('clock'),
  });
}
