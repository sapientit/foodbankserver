import { Hono, type Context } from 'hono';
import { UnauthorizedError } from '../../core/errors.ts';
import type { Actor } from '../../core/actor.ts';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { stockCountingAuth } from '../../http/middleware/stock-counting-auth.ts';
import { parseJsonBody, parseOrThrow } from '../../http/validate.ts';
import { volunteerCodeServiceFrom } from './volunteer-code.service.ts';
import type { AppEnv } from '../../http/types.ts';
import type { StockTakeGrouping } from '../../db/schema/crates.ts';
import { createCratesRepository, type CrateWithMembers } from './crates.repository.ts';
import { createCratesService } from './crates.service.ts';
import { crateInputSchema, cratePatchSchema } from './crates.schema.ts';
import { createGroupingsRepository } from './groupings.repository.ts';
import { createGroupingsService } from './groupings.service.ts';
import { groupingInputSchema, groupingPatchSchema } from './groupings.schema.ts';
import { createStockRepository, type StockLevel } from './stock.repository.ts';
import { createStockService } from './stock.service.ts';
import type { StockValidationIssue } from './stock-validation.ts';
import {
  stockItemInputSchema,
  stockItemPatchSchema,
  stockOrderSchema,
  stockSearchSchema,
  stockCorrectionSchema,
  stockTakeCountsSchema,
  type StockOrder,
} from './stock.schema.ts';

interface StockItemResponse {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string | null;
  readonly shelfNumber: string;
  readonly lowStockThreshold: number | null;
  readonly groupingId: string | null;
  readonly unitsPerPack: number | null;
  readonly packUnitLabel: string | null;
  readonly isActive: boolean;
}

interface LowStockSummaryResponse {
  readonly lowStockCount: number;
}

interface StockCorrectionResponse {
  readonly quantityOnHand: number;
}

interface VolunteerCodeResponse {
  readonly code: string;
  readonly expiresAt: number;
}

interface LatestVolunteerCodeResponse {
  readonly latest: {
    readonly expiresAt: number;
    readonly expiringSoon: boolean;
  } | null;
}

interface StockLevelResponse extends StockItemResponse {
  readonly quantityOnHand: number;
}

interface GroupingResponse {
  readonly id: string;
  readonly name: string;
}

interface CrateMemberResponse {
  readonly stockItemId: string;
  readonly stockCompositionPercent: number;
  readonly shoppingCompositionPercent: number;
}

interface CrateResponse {
  readonly id: string;
  readonly name: string;
  readonly shelfKey: string;
  readonly groupingId: string;
  readonly sizePerCrate: number;
  readonly members: CrateMemberResponse[];
}

/**
 * Team leads handle the stock itself: they read it and they count it, because
 * they are the people in the warehouse. Only an admin changes what the stock
 * *list* is — adding a line or moving a shelf number reshapes every pick list
 * and every stock take that follows. Groupings and crates follow the same
 * split: both roles use the grouped stock take, but only an admin sets up
 * what a grouping or a crate is.
 *
 * The grouped stock take — the level list, the groupings, the crates, and
 * saving a counted page — is additionally reachable by a volunteer holding a
 * code a team lead handed out (`stockCountingAuth`, `INITIAL_SPEC1.txt`
 * #Stock maintenance). Nothing else here is: not the item list, not a
 * correction, not the validation report. That boundary is enforced by
 * `stockCountingAuth` sitting on those four routes and `...staff` on the rest.
 */
export function stockRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const staff = [requireAuth, requireRole('admin', 'team_lead')] as const;
  const admins = [requireAuth, requireRole('admin')] as const;

  /** The stock-take list, ordered by shelf so a picker walks the aisle once. */
  routes.get('/stock/levels', stockCountingAuth, async (c) => {
    const includeInactive = c.req.query('includeInactive') === 'true';
    const levels = await serviceFor(c).listLevels(!includeInactive, orderOf(c, 'shelf'));

    return c.json<{ items: StockLevelResponse[] }>({ items: levels.map(toLevelResponse) });
  });

  /** Autocomplete: type "sug", get "Sugar". */
  routes.get('/stock/search', ...staff, async (c) => {
    const { q } = parseOrThrow(stockSearchSchema, { q: c.req.query('q') });
    const items = await serviceFor(c).searchItems(q);

    return c.json<{ items: StockItemResponse[] }>({ items: items.map(toItemResponse) });
  });

  routes.get('/stock/items', ...staff, async (c) => {
    const items = await serviceFor(c).listItems(
      c.req.query('includeInactive') !== 'true',
      orderOf(c, 'category'),
    );
    return c.json<{ items: StockItemResponse[] }>({ items: items.map(toItemResponse) });
  });

  routes.post('/stock/items', ...admins, async (c) => {
    const input = await parseJsonBody(c, stockItemInputSchema);
    const created = await serviceFor(c).createItem(input);

    c.get('logger').info('created stock item', { stockItemId: created.id });
    return c.json(toItemResponse(created), 201);
  });

  /**
   * A single server-computed count, for the admin dashboard. Admin only,
   * unlike the rest of the stock routes: the underlying thresholds are a
   * maintenance concern and a team lead never sees this figure.
   */
  routes.get('/stock/items/low-stock-summary', ...admins, async (c) => {
    const lowStockCount = await serviceFor(c).countLowStock();
    return c.json<LowStockSummaryResponse>({ lowStockCount });
  });

  routes.patch('/stock/items/:id', ...admins, async (c) => {
    const { isActive, ...rest } = await parseJsonBody(c, stockItemPatchSchema);
    const updated = await serviceFor(c).updateItem(c.req.param('id'), {
      ...rest,
      ...(isActive === undefined ? {} : { isActive: isActive ? 1 : 0 }),
    });

    return c.json(toItemResponse(updated));
  });

  /**
   * One saved page of a stock take. The count replaces what the system held.
   *
   * Not `/stock/takes` — there is no stock take object to create or to get.
   * Each page save stands on its own, so the resource is the act of counting
   * rather than a thing with a lifecycle.
   */
  routes.post('/stock/take', stockCountingAuth, async (c) => {
    const { counts, crateCounts } = await parseJsonBody(c, stockTakeCountsSchema);
    const result = await serviceFor(c).recordStockTake(counts, crateCounts, countingActorOf(c));

    return c.json(result);
  });

  /**
   * A stock-take volunteer code, for a team lead to read out to whoever is
   * counting the shelves that morning. `...staff` — a code cannot mint another
   * code. The plaintext is in this response and nowhere else; it is stored
   * only as a hash and cannot be shown again.
   */
  routes.post('/stock/take/volunteer-codes', ...staff, async (c) => {
    const actor = actorOf(c);
    const { code, expiresAt } = await volunteerCodeServiceFrom(
      c.get('db'),
      c.get('clock'),
    ).generate(actor.userId);

    c.get('logger').info('generated a stock-take volunteer code', { userId: actor.userId });
    return c.json<VolunteerCodeResponse>({ code, expiresAt }, 201);
  });

  /**
   * When the current volunteer code expires and whether it is within five days
   * of lapsing, for the admin screen's "hand out a fresh code" warning
   * (`INITIAL_SPEC1.txt`, #Stock maintenance). Admin only. Never returns the
   * code — only a hash is stored. `latest` is `null` when there is no unexpired
   * code: before the first is generated, or once the last has lapsed.
   */
  routes.get('/stock/take/volunteer-codes/latest', ...admins, async (c) => {
    const latest = await volunteerCodeServiceFrom(c.get('db'), c.get('clock')).latest();
    return c.json<LatestVolunteerCodeResponse>({ latest });
  });

  /**
   * A team lead's hand correction to one item's level, between one take and
   * the next. `...staff`, the same as the stock take it belongs with: an
   * administrator can do everything a team lead can, without exception.
   */
  routes.post('/stock/items/:id/corrections', ...staff, async (c) => {
    const { quantityDelta } = await parseJsonBody(c, stockCorrectionSchema);
    const result = await serviceFor(c).applyCorrection(
      c.req.param('id'),
      quantityDelta,
      actorOf(c),
    );
    return c.json<StockCorrectionResponse>(result);
  });

  routes.get('/stock/groupings', stockCountingAuth, async (c) => {
    const groupings = await groupingsServiceFor(c).listGroupings();
    return c.json<{ items: GroupingResponse[] }>({ items: groupings.map(toGroupingResponse) });
  });

  routes.post('/stock/groupings', ...admins, async (c) => {
    const { name } = await parseJsonBody(c, groupingInputSchema);
    const created = await groupingsServiceFor(c).createGrouping(name);
    return c.json(toGroupingResponse(created), 201);
  });

  routes.patch('/stock/groupings/:id', ...admins, async (c) => {
    const { name } = await parseJsonBody(c, groupingPatchSchema);
    const updated = await groupingsServiceFor(c).updateGrouping(c.req.param('id'), name);
    return c.json(toGroupingResponse(updated));
  });

  routes.get('/stock/crates', stockCountingAuth, async (c) => {
    const crates = await cratesServiceFor(c).listCrates();
    return c.json<{ items: CrateResponse[] }>({ items: crates.map(toCrateResponse) });
  });

  routes.post('/stock/crates', ...admins, async (c) => {
    const input = await parseJsonBody(c, crateInputSchema);
    const created = await cratesServiceFor(c).createCrate(input);
    return c.json(toCrateResponse(created), 201);
  });

  routes.patch('/stock/crates/:id', ...admins, async (c) => {
    const input = await parseJsonBody(c, cratePatchSchema);
    const updated = await cratesServiceFor(c).updateCrate(c.req.param('id'), input);
    return c.json(toCrateResponse(updated));
  });

  routes.delete('/stock/crates/:id', ...admins, async (c) => {
    await cratesServiceFor(c).deleteCrate(c.req.param('id'));
    return c.body(null, 204);
  });

  /**
   * The non-blocking consistency report. Admin only: it is a maintenance
   * concern about the stock *list*, the same split as the item list itself.
   * Never referenced to reject a write — see `stock-validation.ts`.
   */
  routes.get('/stock/validation', ...admins, async (c) => {
    const issues = await serviceFor(c).computeValidationIssues();
    return c.json<{ issues: StockValidationIssue[] }>({ issues });
  });

  return routes;
}

function toItemResponse(item: {
  id: string;
  name: string;
  category: string;
  description: string | null;
  shelfNumber: string;
  lowStockThreshold: number | null;
  groupingId: string | null;
  unitsPerPack: number | null;
  packUnitLabel: string | null;
  isActive: number;
}): StockItemResponse {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    description: item.description,
    shelfNumber: item.shelfNumber,
    lowStockThreshold: item.lowStockThreshold,
    groupingId: item.groupingId,
    unitsPerPack: item.unitsPerPack,
    packUnitLabel: item.packUnitLabel,
    isActive: item.isActive === 1,
  };
}

/**
 * The order a list is asked for, falling back to the one its screen wants.
 *
 * Each route defaults to the order the screen behind it needs — category for
 * the maintenance and pick-list amendment screens, shelf for the stock take —
 * so neither has to ask. An unrecognised value is a `400` rather than a silent
 * fallback: a client that misspells it should hear about it, not quietly get a
 * pick list in the wrong order.
 */
function orderOf(c: Context<AppEnv>, fallback: StockOrder): StockOrder {
  const requested = c.req.query('order');
  return requested === undefined ? fallback : parseOrThrow(stockOrderSchema, requested);
}

function toLevelResponse(level: StockLevel): StockLevelResponse {
  return {
    ...toItemResponse(level.item),
    quantityOnHand: level.quantityOnHand,
  };
}

function toGroupingResponse(grouping: StockTakeGrouping): GroupingResponse {
  return { id: grouping.id, name: grouping.name };
}

function toCrateResponse(entry: CrateWithMembers): CrateResponse {
  return {
    id: entry.crate.id,
    name: entry.crate.name,
    shelfKey: entry.crate.shelfKey,
    groupingId: entry.crate.groupingId,
    sizePerCrate: entry.crate.sizePerCrate,
    members: entry.members.map((member) => ({
      stockItemId: member.stockItemId,
      stockCompositionPercent: member.stockCompositionPercent,
      shoppingCompositionPercent: member.shoppingCompositionPercent,
    })),
  };
}

function actorOf(c: Context<AppEnv>): Actor {
  const actor = c.get('actor');
  if (actor === undefined) {
    throw new UnauthorizedError('Authentication required');
  }
  return actor;
}

/**
 * Who to record a counted page against, whichever way the request authenticated:
 * the signed-in user, or the team lead who issued the volunteer code in play.
 * `stockCountingAuth` guarantees exactly one of the two is set.
 */
function countingActorOf(c: Context<AppEnv>): { actorUserId: string } {
  const actor = c.get('actor');
  if (actor !== undefined) {
    return { actorUserId: actor.userId };
  }
  const volunteerCode = c.get('volunteerCode');
  if (volunteerCode !== undefined) {
    return { actorUserId: volunteerCode.createdByUserId };
  }
  throw new UnauthorizedError('Authentication required');
}

function serviceFor(c: Context<AppEnv>) {
  const db = c.get('db');
  return createStockService({
    db,
    repository: createStockRepository(db),
    cratesRepository: createCratesRepository(db),
    clock: c.get('clock'),
    logger: c.get('logger'),
  });
}

function groupingsServiceFor(c: Context<AppEnv>) {
  const db = c.get('db');
  return createGroupingsService({
    repository: createGroupingsRepository(db),
    clock: c.get('clock'),
  });
}

function cratesServiceFor(c: Context<AppEnv>) {
  const db = c.get('db');
  return createCratesService({ repository: createCratesRepository(db), clock: c.get('clock') });
}
