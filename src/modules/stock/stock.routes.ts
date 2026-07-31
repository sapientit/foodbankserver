import { Hono, type Context } from 'hono';
import { UnauthorizedError } from '../../core/errors.ts';
import type { Actor } from '../../core/actor.ts';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseJsonBody, parseOrThrow } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import { createStockRepository, type StockLevel } from './stock.repository.ts';
import { createStockService } from './stock.service.ts';
import {
  purchaseInputSchema,
  stockAdjustmentSchema,
  stockItemInputSchema,
  stockItemPatchSchema,
  stockSearchSchema,
  stockTakeCountsSchema,
  stockTakeInputSchema,
} from './stock.schema.ts';

interface StockItemResponse {
  readonly id: string;
  readonly name: string;
  readonly shelfNumber: string;
  readonly isActive: boolean;
}

interface StockLevelResponse extends StockItemResponse {
  readonly quantityOnHand: number;
}

/**
 * Team leads handle the stock itself: they read it, shop for it, count it and
 * correct it, because they are the people in the warehouse. Only an admin
 * changes what the stock *list* is — adding a line or moving a shelf number
 * reshapes every pick list and every stock take that follows.
 */
export function stockRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const staff = [requireAuth, requireRole('admin', 'team_lead')] as const;
  const admins = [requireAuth, requireRole('admin')] as const;

  /** The stock-take and picking list, ordered by shelf so a picker walks once. */
  routes.get('/stock/levels', ...staff, async (c) => {
    const includeInactive = c.req.query('includeInactive') === 'true';
    const levels = await serviceFor(c).listLevels(!includeInactive);

    return c.json<{ items: StockLevelResponse[] }>({ items: levels.map(toLevelResponse) });
  });

  /** Autocomplete: type "sug", get "Sugar". */
  routes.get('/stock/search', ...staff, async (c) => {
    const { q } = parseOrThrow(stockSearchSchema, { q: c.req.query('q') });
    const items = await serviceFor(c).searchItems(q);

    return c.json<{ items: StockItemResponse[] }>({ items: items.map(toItemResponse) });
  });

  routes.get('/stock/items', ...staff, async (c) => {
    const items = await serviceFor(c).listItems(c.req.query('includeInactive') !== 'true');
    return c.json<{ items: StockItemResponse[] }>({ items: items.map(toItemResponse) });
  });

  routes.post('/stock/items', ...admins, async (c) => {
    const input = await parseJsonBody(c, stockItemInputSchema);
    const created = await serviceFor(c).createItem(input);

    c.get('logger').info('created stock item', { stockItemId: created.id });
    return c.json(toItemResponse(created), 201);
  });

  routes.patch('/stock/items/:id', ...admins, async (c) => {
    const { isActive, ...rest } = await parseJsonBody(c, stockItemPatchSchema);
    const updated = await serviceFor(c).updateItem(c.req.param('id'), {
      ...rest,
      ...(isActive === undefined ? {} : { isActive: isActive ? 1 : 0 }),
    });

    return c.json(toItemResponse(updated));
  });

  /** Recording a shop. */
  routes.post('/stock/purchases', ...staff, async (c) => {
    const input = await parseJsonBody(c, purchaseInputSchema);
    const result = await serviceFor(c).recordPurchase(input, actorOf(c));

    return c.json(result, 201);
  });

  routes.post('/stock/adjustments', ...staff, async (c) => {
    const input = await parseJsonBody(c, stockAdjustmentSchema);
    await serviceFor(c).adjust(input, actorOf(c));

    return c.body(null, 204);
  });

  // ---- Stock takes ----

  routes.get('/stock/takes', ...staff, async (c) => {
    const takes = await serviceFor(c).listStockTakes();
    return c.json({
      stockTakes: takes.map((take) => ({
        id: take.id,
        countedAt: take.countedAt,
        status: take.status,
        note: take.note,
        committedAt: take.committedAt,
      })),
    });
  });

  routes.post('/stock/takes', ...staff, async (c) => {
    const { note } = await parseJsonBody(c, stockTakeInputSchema);
    const created = await serviceFor(c).openStockTake(note, actorOf(c));

    return c.json({ id: created.id, status: created.status }, 201);
  });

  routes.post('/stock/takes/:id/counts', ...staff, async (c) => {
    const { counts } = await parseJsonBody(c, stockTakeCountsSchema);
    await serviceFor(c).recordCounts(c.req.param('id'), counts);

    return c.body(null, 204);
  });

  routes.post('/stock/takes/:id/commit', ...staff, async (c) => {
    const result = await serviceFor(c).commitStockTake(c.req.param('id'), actorOf(c));

    return c.json({
      id: result.stockTake.id,
      status: result.stockTake.status,
      committedAt: result.stockTake.committedAt,
      adjustments: result.adjustments,
    });
  });

  return routes;
}

function toItemResponse(item: {
  id: string;
  name: string;
  shelfNumber: string;
  isActive: number;
}): StockItemResponse {
  return {
    id: item.id,
    name: item.name,
    shelfNumber: item.shelfNumber,
    isActive: item.isActive === 1,
  };
}

function toLevelResponse(level: StockLevel): StockLevelResponse {
  return {
    ...toItemResponse(level.item),
    quantityOnHand: level.quantityOnHand,
  };
}

function actorOf(c: Context<AppEnv>): Actor {
  const actor = c.get('actor');
  if (actor === undefined) {
    throw new UnauthorizedError('Authentication required');
  }
  return actor;
}

function serviceFor(c: Context<AppEnv>) {
  const db = c.get('db');
  return createStockService({
    db,
    repository: createStockRepository(db),
    clock: c.get('clock'),
    logger: c.get('logger'),
  });
}
