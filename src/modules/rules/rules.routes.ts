import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseJsonBody } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import type { ModelParcel } from '../../db/schema/rules.ts';
import { allGridKeys } from './engine.ts';
import { createRulesRepository } from './rules.repository.ts';
import { createRulesService, parseContents } from './rules.service.ts';

const contentsSchema = z
  .array(
    z.object({
      stockItemId: z.uuid(),
      quantity: z.number().int().min(1).max(1000),
    }),
  )
  .max(200);

const modelParcelInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullable().default(null),
  contents: contentsSchema.min(1),
  displayOrder: z.number().int().min(0).max(1000).default(0),
});

const modelParcelPatchSchema = z
  .object({
    description: z.string().trim().max(300).nullable(),
    contents: contentsSchema.min(1),
    displayOrder: z.number().int().min(0).max(1000),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

/** The grid arrives whole: `{ "1-0": "Single parcel", … }`. */
const gridSchema = z.object({
  grid: z.record(
    z.string().regex(/^\d+-\d+$/, 'must be an adults-children key'),
    z.string().trim().min(1).max(80),
  ),
});

const previewSchema = z.object({
  adults: z.number().int().min(0).max(30),
  children: z.number().int().min(0).max(30),
});

/**
 * Model parcels and the household grid. **Administrator only, reading as well
 * as writing.**
 *
 * What goes in a parcel is charity policy, and the charity has said there is no
 * reason for a team lead ever to look. A picker holding a sheet already has the
 * thing that matters on it — the parcel's actual contents, copied at
 * generation — and the model it came from tells them nothing they can act on.
 * These routes were briefly readable by a team lead on the guess that it would
 * help answer "why has this parcel got three tins?"; that guess was wrong, and
 * it is the same one that made the stock roles wrong before it.
 *
 * There is no draft or publish step. A pick list copies the contents it needs
 * when it is generated, so an edit here affects future pick lists only.
 */
export function ruleRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const admins = [requireAuth, requireRole('admin')] as const;

  routes.get('/model-parcels', ...admins, async (c) => {
    const parcels = await serviceFor(c).listModelParcels();
    return c.json({ modelParcels: parcels.map(toModelParcelResponse) });
  });

  routes.post('/model-parcels', ...admins, async (c) => {
    const input = await parseJsonBody(c, modelParcelInputSchema);
    const created = await serviceFor(c).addModelParcel(input);

    c.get('logger').info('created model parcel', { count: input.contents.length });
    return c.json(toModelParcelResponse(created), 201);
  });

  routes.patch('/model-parcels/:id', ...admins, async (c) => {
    const patch = await parseJsonBody(c, modelParcelPatchSchema);
    const updated = await serviceFor(c).updateModelParcel(c.req.param('id'), patch);

    return c.json(toModelParcelResponse(updated));
  });

  routes.delete('/model-parcels/:id', ...admins, async (c) => {
    await serviceFor(c).deleteModelParcel(c.req.param('id'));
    return c.body(null, 204);
  });

  /** The grid, plus what is still missing from it. */
  routes.get('/parcel-grid', ...admins, async (c) => {
    const status = await serviceFor(c).gridStatus();

    return c.json({
      grid: status.grid,
      cells: allGridKeys(),
      isComplete: status.ok,
      missingCells: status.missingCells,
      unknownParcels: status.unknownParcels,
    });
  });

  /** Saved whole, never cell by cell. */
  routes.put('/parcel-grid', ...admins, async (c) => {
    const { grid } = await parseJsonBody(c, gridSchema);
    const saved = await serviceFor(c).saveGrid(grid);

    c.get('logger').info('saved the household grid', { count: Object.keys(saved).length });
    return c.json({ grid: saved });
  });

  /**
   * "What would a family of two adults and three children get?"
   *
   * Runs the same lookup generation does, so what an administrator checks here
   * is what a picker will see. Admin-only with the rest: it is a window onto
   * the same model parcels.
   */
  routes.post('/parcel-grid/preview', ...admins, async (c) => {
    const household = await parseJsonBody(c, previewSchema);
    const resolved = await serviceFor(c).resolveForHousehold(household);

    return c.json({
      household: { ...household, size: household.adults + household.children },
      modelParcelName: resolved.modelParcelName,
      lines: resolved.lines,
    });
  });

  return routes;
}

function toModelParcelResponse(parcel: ModelParcel) {
  return {
    id: parcel.id,
    name: parcel.name,
    description: parcel.description,
    contents: parseContents(parcel.contentsJson),
    displayOrder: parcel.displayOrder,
  };
}

function serviceFor(c: Context<AppEnv>) {
  return createRulesService({
    repository: createRulesRepository(c.get('db')),
    clock: c.get('clock'),
  });
}
