import { describe, expect, it } from 'vitest';
import {
  decomposeCrateCount,
  type CrateDecompositionInput,
} from '../src/modules/stock/crate-decomposition.ts';

describe('decomposeCrateCount', () => {
  it('splits an entered count evenly across an even-percentage split', () => {
    const crate: CrateDecompositionInput = {
      sizePerCrate: 10,
      members: [
        { stockItemId: 'a', stockCompositionPercent: 50 },
        { stockItemId: 'b', stockCompositionPercent: 50 },
      ],
    };

    const result = decomposeCrateCount(crate, 2);

    expect(result).toEqual([
      { stockItemId: 'a', countedQuantity: 10 },
      { stockItemId: 'b', countedQuantity: 10 },
    ]);
  });

  it('rounds each member independently, so the parts need not sum back to enteredCount * sizePerCrate', () => {
    // enteredCount(1) * sizePerCrate(7) = 7 raw units, split 50/50 is 3.5 each.
    // Each member rounds its own 3.5 up to 4 independently, giving a total of
    // 8 — one more than the 7 units actually counted. That drift is accepted
    // deliberately: see the comment on decomposeCrateCount.
    const crate: CrateDecompositionInput = {
      sizePerCrate: 7,
      members: [
        { stockItemId: 'a', stockCompositionPercent: 50 },
        { stockItemId: 'b', stockCompositionPercent: 50 },
      ],
    };

    const result = decomposeCrateCount(crate, 1);

    expect(result).toEqual([
      { stockItemId: 'a', countedQuantity: 4 },
      { stockItemId: 'b', countedQuantity: 4 },
    ]);
    const total = result.reduce((sum, member) => sum + member.countedQuantity, 0);
    expect(total).not.toBe(1 * 7);
  });

  it('gives every member zero when the entered count is zero', () => {
    const crate: CrateDecompositionInput = {
      sizePerCrate: 10,
      members: [
        { stockItemId: 'a', stockCompositionPercent: 60 },
        { stockItemId: 'b', stockCompositionPercent: 40 },
      ],
    };

    const result = decomposeCrateCount(crate, 0);

    expect(result).toEqual([
      { stockItemId: 'a', countedQuantity: 0 },
      { stockItemId: 'b', countedQuantity: 0 },
    ]);
  });

  it('handles a fractional entered count', () => {
    const crate: CrateDecompositionInput = {
      sizePerCrate: 4,
      members: [
        { stockItemId: 'a', stockCompositionPercent: 50 },
        { stockItemId: 'b', stockCompositionPercent: 50 },
      ],
    };

    // 1.5 * 4 = 6 raw units, split 50/50 is 3 each — chosen to land exactly so
    // this test is about the fractional entered count, not rounding.
    const result = decomposeCrateCount(crate, 1.5);

    expect(result).toEqual([
      { stockItemId: 'a', countedQuantity: 3 },
      { stockItemId: 'b', countedQuantity: 3 },
    ]);
  });
});
