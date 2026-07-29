import { describe, expect, it } from 'vitest';
import {
  allGridKeys,
  clampHousehold,
  gridKey,
  modelParcelNameFor,
  normaliseContents,
  validateGrid,
  type ParcelGrid,
} from '../src/modules/rules/engine.ts';
import { GRID_CELL_COUNT } from '../src/db/schema/rules.ts';

/** A complete grid: singles, couples and families, sharing three parcels. */
function completeGrid(): ParcelGrid {
  const grid: ParcelGrid = {};
  for (const key of allGridKeys()) {
    const [adults, children] = key.split('-').map(Number);
    const size = (adults ?? 0) + (children ?? 0);
    grid[key] = size <= 1 ? 'Single parcel' : size <= 4 ? 'Family parcel' : 'Large family parcel';
  }
  return grid;
}

const PARCEL_NAMES = ['Single parcel', 'Family parcel', 'Large family parcel'];

/** A grid with one cell removed, without mutating the original. */
function withoutCell(grid: ParcelGrid, cell: string): ParcelGrid {
  return Object.fromEntries(Object.entries(grid).filter(([key]) => key !== cell));
}

describe('the household grid', () => {
  it('covers 1-5 adults by 0-5 children, thirty cells', () => {
    const keys = allGridKeys();

    expect(keys).toHaveLength(30);
    expect(GRID_CELL_COUNT).toBe(30);
    expect(keys[0]).toBe('1-0');
    expect(keys.at(-1)).toBe('5-5');
    expect(new Set(keys).size).toBe(30);
  });

  it('clamps a household larger than the grid into its corner', () => {
    // Six adults are fed as five; seven children as five.
    expect(clampHousehold({ adults: 6, children: 7 })).toEqual({ adults: 5, children: 5 });
    expect(clampHousehold({ adults: 12, children: 0 })).toEqual({ adults: 5, children: 0 });
  });

  it('clamps zero adults up to one', () => {
    // Referrals are refused with zero adults, but old or imported data must
    // still resolve to a parcel rather than throwing while a picker waits.
    expect(clampHousehold({ adults: 0, children: 3 })).toEqual({ adults: 1, children: 3 });
  });

  it('leaves a household already inside the grid alone', () => {
    expect(clampHousehold({ adults: 2, children: 3 })).toEqual({ adults: 2, children: 3 });
  });

  it('looks up the model parcel for a household', () => {
    const grid = completeGrid();

    expect(modelParcelNameFor(grid, { adults: 1, children: 0 })).toBe('Single parcel');
    expect(modelParcelNameFor(grid, { adults: 2, children: 2 })).toBe('Family parcel');
    expect(modelParcelNameFor(grid, { adults: 3, children: 3 })).toBe('Large family parcel');
  });

  it('looks up an oversized household via the clamped cell', () => {
    const grid = completeGrid();

    expect(modelParcelNameFor(grid, { adults: 9, children: 9 })).toBe(
      modelParcelNameFor(grid, { adults: 5, children: 5 }),
    );
  });

  it('reports a blank cell rather than guessing', () => {
    const grid = withoutCell(completeGrid(), gridKey(2, 2));

    expect(modelParcelNameFor(grid, { adults: 2, children: 2 })).toBeUndefined();
  });
});

describe('grid validation', () => {
  it('accepts a complete, consistent grid', () => {
    expect(validateGrid(completeGrid(), PARCEL_NAMES)).toMatchObject({
      ok: true,
      missingCells: [],
      unknownParcels: [],
      unexpectedCells: [],
    });
  });

  it('reports every blank cell, so publishing cannot half-work', () => {
    const grid = { ...withoutCell(completeGrid(), '3-3'), '4-4': '   ' };

    const result = validateGrid(grid, PARCEL_NAMES);

    expect(result.ok).toBe(false);
    expect(result.missingCells.sort()).toEqual(['3-3', '4-4']);
  });

  it('reports a cell naming a parcel that does not exist', () => {
    const grid = completeGrid();
    grid['1-1'] = 'Deleted parcel';

    const result = validateGrid(grid, PARCEL_NAMES);

    expect(result.ok).toBe(false);
    expect(result.unknownParcels).toEqual([{ cell: '1-1', name: 'Deleted parcel' }]);
  });

  it('reports a cell that is not a real household size', () => {
    const grid = { ...completeGrid(), '9-9': 'Family parcel' };

    const result = validateGrid(grid, PARCEL_NAMES);

    expect(result.ok).toBe(false);
    expect(result.unexpectedCells).toEqual(['9-9']);
  });

  it('reports an entirely empty grid as thirty missing cells', () => {
    expect(validateGrid({}, PARCEL_NAMES).missingCells).toHaveLength(30);
  });
});

describe('model parcel contents', () => {
  it('merges duplicate items so a picker never sees one twice', () => {
    const contents = normaliseContents([
      { stockItemId: 'beans', quantity: 2 },
      { stockItemId: 'pasta', quantity: 1 },
      { stockItemId: 'beans', quantity: 3 },
    ]);

    expect(contents).toEqual([
      { stockItemId: 'beans', quantity: 5 },
      { stockItemId: 'pasta', quantity: 1 },
    ]);
  });

  it('drops anything that works out to nothing', () => {
    const contents = normaliseContents([
      { stockItemId: 'beans', quantity: 2 },
      { stockItemId: 'sugar', quantity: 0 },
      { stockItemId: 'rice', quantity: -1 },
    ]);

    expect(contents).toEqual([{ stockItemId: 'beans', quantity: 2 }]);
  });

  it('is order-independent', () => {
    const forwards = normaliseContents([
      { stockItemId: 'beans', quantity: 2 },
      { stockItemId: 'pasta', quantity: 1 },
    ]);
    const backwards = normaliseContents([
      { stockItemId: 'pasta', quantity: 1 },
      { stockItemId: 'beans', quantity: 2 },
    ]);

    expect(forwards).toEqual(backwards);
  });
});
