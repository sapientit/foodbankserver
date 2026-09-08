import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseJsonBody } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import type { TargetStockListRow } from '../../db/schema/target-stock-lists.ts';
import { createCratesRepository } from '../stock/crates.repository.ts';
import { createCratesService } from '../stock/crates.service.ts';
import { createTargetStockListsRepository } from './target-stock-lists.repository.ts';
import { createTargetStockListsService, parseLines } from './target-stock-lists.service.ts';

const itemLineSchema = z.object({
  kind: z.literal('item'),
  // Not validated against the stock item catalogue on write — settled
  // 2026-08-31 (was Q46). See the comment on the service.
  stockItemId: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  targetQuantity: z.number().int().min(1).max(100_000),
});

/**
 * A crate line beside an item line — same snapshot design: `crateId` and
 * `crateName` are stored as they stood when the line was saved, never
 * revalidated against the live crate. `targetQuantity` allows one decimal
 * place, unlike an item line's whole-number target, because a shopping run
 * can reasonably ask for half a crate.
 */
const crateLineSchema = z.object({
  kind: z.literal('crate'),
  crateId: z.string().trim().min(1).max(100),
  crateName: z.string().trim().min(1).max(120),
  targetQuantity: z.number().min(0.1).max(100_000).multipleOf(0.1),
});

const lineSchema = z.discriminatedUnion('kind', [itemLineSchema, crateLineSchema]);

const linesSchema = z
  .array(lineSchema)
  .max(500)
  .refine(
    (lines) =>
      new Set(
        lines.map((line) =>
          line.kind === 'item' ? `item:${line.stockItemId}` : `crate:${line.crateId}`,
        ),
      ).size === lines.length,
    'the same stockItemId or crateId appears twice',
  );

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  lines: linesSchema,
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    lines: linesSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

/**
 * Named standing target stock lists an administrator maintains, and a team
 * leader shops against. See `INITIAL_SPEC1.txt`, `#Target stock lists and
 * shopping`.
 *
 * **Reading is admin and team lead; maintaining is admin only.** Unlike model
 * parcels — admin-only even to read, because a team lead has no reason to see
 * that policy data — a team lead reading a target stock list whole, target
 * quantities and all, is fine: they are the one who counts the shelves each
 * week and stands in the stock room, so nothing on this list tells them
 * something they could not see for themselves. Settled 2026-08-31, was Q48.
 *
 * `name` is amendable via `PATCH`, settled 2026-08-31 (was Q44) — unlike a
 * model parcel's, nothing else refers to a target stock list by name.
 */
export function targetStockListRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const readers = [requireAuth, requireRole('admin', 'team_lead')] as const;
  const admins = [requireAuth, requireRole('admin')] as const;

  routes.get('/target-stock-lists', ...readers, async (c) => {
    const lists = await serviceFor(c).listTargetStockLists();
    return c.json({ targetStockLists: lists.map(toTargetStockListResponse) });
  });

  routes.post('/target-stock-lists', ...admins, async (c) => {
    const input = await parseJsonBody(c, createSchema);
    const created = await serviceFor(c).createTargetStockList(input);

    c.get('logger').info('created target stock list', { count: input.lines.length });
    return c.json(toTargetStockListResponse(created), 201);
  });

  routes.patch('/target-stock-lists/:id', ...admins, async (c) => {
    const patch = await parseJsonBody(c, patchSchema);
    const updated = await serviceFor(c).updateTargetStockList(c.req.param('id'), patch);

    return c.json(toTargetStockListResponse(updated));
  });

  routes.delete('/target-stock-lists/:id', ...admins, async (c) => {
    await serviceFor(c).deleteTargetStockList(c.req.param('id'));
    return c.body(null, 204);
  });

  return routes;
}

function toTargetStockListResponse(list: TargetStockListRow) {
  return {
    id: list.id,
    name: list.name,
    lines: parseLines(list.linesJson),
  };
}

function serviceFor(c: Context<AppEnv>) {
  const db = c.get('db');
  return createTargetStockListsService({
    repository: createTargetStockListsRepository(db),
    // Reached through the crates *service*, not its repository directly —
    // this module and `stock` talk to each other the way any two modules do.
    crates: createCratesService({ repository: createCratesRepository(db), clock: c.get('clock') }),
    clock: c.get('clock'),
  });
}
