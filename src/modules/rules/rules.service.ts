import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError, UnprocessableError } from '../../core/errors.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import type { Patch } from '../../core/types.ts';
import type { ModelParcel, NewModelParcel } from '../../db/schema/rules.ts';
import {
  modelParcelNameFor,
  normaliseContents,
  validateGrid,
  type Household,
  type ModelParcelLine,
  type ParcelGrid,
} from './engine.ts';
import type { RulesRepository } from './rules.repository.ts';

export interface RulesServiceDeps {
  readonly repository: RulesRepository;
  readonly clock: Clock;
}

export interface ResolvedParcel {
  readonly modelParcelName: string;
  readonly lines: ModelParcelLine[];
}

/**
 * Model parcels and the household grid.
 *
 * **Nothing here is versioned.** A pick list copies the contents it needs at
 * generation, so editing a model parcel afterwards cannot change a list that
 * already exists. The copy is the guarantee; a draft/publish lifecycle on top
 * would be ceremony protecting something already protected.
 */
export function createRulesService({ repository, clock }: RulesServiceDeps) {
  async function listModelParcels(): Promise<ModelParcel[]> {
    return repository.listModelParcels();
  }

  async function getGrid(): Promise<ParcelGrid> {
    const row = await repository.findGrid();
    return row === undefined ? {} : parseGrid(row.gridJson);
  }

  async function addModelParcel(input: {
    name: string;
    description: string | null;
    contents: ModelParcelLine[];
    displayOrder: number;
  }): Promise<ModelParcel> {
    const now = clock.nowIso();

    try {
      return await repository.insertModelParcel({
        id: crypto.randomUUID(),
        name: input.name,
        description: input.description,
        contentsJson: JSON.stringify(normaliseContents(input.contents)),
        displayOrder: input.displayOrder,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'model_parcels.name')) {
        throw new ConflictError('A model parcel with that name already exists', { cause: error });
      }
      throw error;
    }
  }

  async function updateModelParcel(
    id: string,
    patch: {
      description?: string | null | undefined;
      contents?: ModelParcelLine[] | undefined;
      displayOrder?: number | undefined;
    },
  ): Promise<ModelParcel> {
    // The name is deliberately not editable: the grid references it, and
    // renaming would silently orphan every cell pointing at it. Delete and
    // recreate, which forces the grid to be revisited.
    const next: Patch<NewModelParcel> = { updatedAt: clock.nowIso() };
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.displayOrder !== undefined) next.displayOrder = patch.displayOrder;
    if (patch.contents !== undefined) {
      next.contentsJson = JSON.stringify(normaliseContents(patch.contents));
    }

    const updated = await repository.updateModelParcel(id, next);
    if (updated === undefined) {
      throw new NotFoundError('Model parcel not found');
    }
    return updated;
  }

  async function deleteModelParcel(id: string): Promise<void> {
    const parcel = await repository.findModelParcelById(id);
    if (parcel === undefined) return; // Idempotent.

    // Refuse if the grid still points at it, rather than leaving cells dangling.
    const grid = await getGrid();
    const referencing = Object.entries(grid)
      .filter(([, name]) => name === parcel.name)
      .map(([cell]) => cell);

    if (referencing.length > 0) {
      throw new ConflictError('That model parcel is still used by the household grid', {
        details: { cells: referencing },
      });
    }

    await repository.deleteModelParcel(id);
  }

  /**
   * Replaces the whole grid.
   *
   * Wholesale by design: the coordinator fills in the thirty cells and saves
   * once, so there is one write and no window in which the grid is half
   * updated — which matters on a database with no transactions.
   *
   * A partly filled grid is allowed while the charity is still setting up. The
   * consequence is that a household landing on a blank cell cannot be placed,
   * which generation reports rather than failing on.
   */
  async function saveGrid(grid: ParcelGrid): Promise<ParcelGrid> {
    const names = (await repository.listModelParcels()).map((parcel) => parcel.name);
    const check = validateGrid(grid, names);

    if (check.unknownParcels.length > 0 || check.unexpectedCells.length > 0) {
      throw new UnprocessableError('That grid does not match the model parcels', {
        details: {
          unknownParcels: check.unknownParcels,
          unexpectedCells: check.unexpectedCells,
        },
      });
    }

    await repository.saveGrid(JSON.stringify(grid), clock.nowIso());
    return grid;
  }

  /** How complete the grid is, so the frontend can show what is left to do. */
  async function gridStatus() {
    const grid = await getGrid();
    const names = (await repository.listModelParcels()).map((parcel) => parcel.name);
    return { grid, ...validateGrid(grid, names) };
  }

  /**
   * What a household would receive right now.
   *
   * The same lookup generation uses, so a preview cannot diverge from what
   * gets picked.
   */
  async function resolveForHousehold(household: Household): Promise<ResolvedParcel> {
    const [grid, parcels] = await Promise.all([getGrid(), repository.listModelParcels()]);

    const name = modelParcelNameFor(grid, household);
    if (name === undefined) {
      throw new UnprocessableError('No model parcel is defined for that household size', {
        details: { adults: household.adults, children: household.children },
      });
    }

    const parcel = parcels.find((candidate) => candidate.name === name);
    if (parcel === undefined) {
      throw new UnprocessableError(
        'The household grid names a model parcel that no longer exists',
        { details: { modelParcelName: name } },
      );
    }

    return { modelParcelName: name, lines: parseContents(parcel.contentsJson) };
  }

  return {
    listModelParcels,
    getGrid,
    gridStatus,
    addModelParcel,
    updateModelParcel,
    deleteModelParcel,
    saveGrid,
    resolveForHousehold,
  };
}

export type RulesService = ReturnType<typeof createRulesService>;

export function parseGrid(gridJson: string | null): ParcelGrid {
  if (gridJson === null) return {};
  try {
    const parsed: unknown = JSON.parse(gridJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

export function parseContents(contentsJson: string): ModelParcelLine[] {
  try {
    const parsed: unknown = JSON.parse(contentsJson);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((entry): ModelParcelLine[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { stockItemId, quantity } = entry as { stockItemId?: unknown; quantity?: unknown };
      return typeof stockItemId === 'string' && typeof quantity === 'number'
        ? [{ stockItemId, quantity }]
        : [];
    });
  } catch {
    return [];
  }
}
