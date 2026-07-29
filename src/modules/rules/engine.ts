import {
  MAX_GRID_ADULTS,
  MAX_GRID_CHILDREN,
  MIN_GRID_ADULTS,
  MIN_GRID_CHILDREN,
} from '../../db/schema/rules.ts';

/**
 * Turning a household into a model parcel.
 *
 * This is a **lookup, not a calculation**. The charity maintains a grid of
 * every household size — 1 to 5 adults by 0 to 5 children, thirty entries —
 * and each entry names the model parcel to use. Households larger than the
 * grid clamp into its corner.
 *
 * Pure: no database, no clock, no I/O. That is what lets a coordinator's
 * question — "what would a family of two adults and three children get?" — be
 * answered by a unit test rather than by generating a real pick list.
 */

export interface Household {
  readonly adults: number;
  readonly children: number;
}

export interface ModelParcelLine {
  readonly stockItemId: string;
  readonly quantity: number;
}

/** `adults-children`, the key used in the grid JSON. */
export type GridKey = string;

/** The grid: every cell maps a household size to a model parcel **name**. */
export type ParcelGrid = Record<GridKey, string>;

export function gridKey(adults: number, children: number): GridKey {
  return `${String(adults)}-${String(children)}`;
}

/**
 * Brings a household inside the grid.
 *
 * Six adults are fed as five, seven children as five. A referral cannot have
 * zero adults — that is refused at submission — but clamping upward anyway
 * means a bad row in old data resolves to a real parcel rather than throwing
 * while a picker waits.
 */
export function clampHousehold(household: Household): Household {
  return {
    adults: clamp(household.adults, MIN_GRID_ADULTS, MAX_GRID_ADULTS),
    children: clamp(household.children, MIN_GRID_CHILDREN, MAX_GRID_CHILDREN),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Every cell the grid must define, in display order. */
export function allGridKeys(): GridKey[] {
  const keys: GridKey[] = [];
  for (let adults = MIN_GRID_ADULTS; adults <= MAX_GRID_ADULTS; adults++) {
    for (let children = MIN_GRID_CHILDREN; children <= MAX_GRID_CHILDREN; children++) {
      keys.push(gridKey(adults, children));
    }
  }
  return keys;
}

/** The model parcel name for a household, or undefined if that cell is blank. */
export function modelParcelNameFor(grid: ParcelGrid, household: Household): string | undefined {
  const clamped = clampHousehold(household);
  return grid[gridKey(clamped.adults, clamped.children)];
}

export interface GridValidation {
  readonly ok: boolean;
  /** Cells with no model parcel named. */
  readonly missingCells: GridKey[];
  /** Cells naming a model parcel that does not exist. */
  readonly unknownParcels: { cell: GridKey; name: string }[];
  /** Cells present in the grid that are not real household sizes. */
  readonly unexpectedCells: GridKey[];
}

/**
 * Checks a grid is complete and internally consistent.
 *
 * Run before publishing. A grid with a blank cell is a pick list that fails
 * halfway through generation on the morning of a session, which is the worst
 * possible moment to discover it.
 */
export function validateGrid(
  grid: ParcelGrid,
  knownParcelNames: readonly string[],
): GridValidation {
  const expected = new Set(allGridKeys());
  const known = new Set(knownParcelNames);

  const missingCells: GridKey[] = [];
  const unknownParcels: { cell: GridKey; name: string }[] = [];

  for (const key of allGridKeys()) {
    const name = grid[key];
    if (name === undefined || name.trim() === '') {
      missingCells.push(key);
    } else if (!known.has(name)) {
      unknownParcels.push({ cell: key, name });
    }
  }

  const unexpectedCells = Object.keys(grid).filter((key) => !expected.has(key));

  return {
    ok: missingCells.length === 0 && unknownParcels.length === 0 && unexpectedCells.length === 0,
    missingCells,
    unknownParcels,
    unexpectedCells,
  };
}

/**
 * Merges duplicate stock items and drops anything at or below zero, so a
 * picker never gets the same item twice or an empty line.
 */
export function normaliseContents(contents: readonly ModelParcelLine[]): ModelParcelLine[] {
  const totals = new Map<string, number>();
  for (const line of contents) {
    totals.set(line.stockItemId, (totals.get(line.stockItemId) ?? 0) + line.quantity);
  }

  return [...totals.entries()]
    .filter(([, quantity]) => quantity > 0)
    .map(([stockItemId, quantity]) => ({ stockItemId, quantity }))
    .sort((a, b) => a.stockItemId.localeCompare(b.stockItemId));
}
