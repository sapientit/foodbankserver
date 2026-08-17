import type { StockItem } from '../../db/schema/stock.ts';

/**
 * What one stock item costs a session, beside what is on the shelf for it.
 *
 * `shortfall` is the number that is missing and never negative: a surplus is
 * not a shortfall, and a screen highlighting "not enough" must not have to
 * work out which sign means trouble.
 */
export interface StockRequirementLine {
  readonly item: StockItem;
  readonly requiredQuantity: number;
  readonly quantityOnHand: number;
  readonly shortfall: number;
}

/**
 * Pairs each item a session's parcels call for with its current level.
 *
 * Driven by `levels` rather than by the requirement, for two reasons: the
 * catalogue arrives already sorted in the order the caller asked for, and an
 * item nothing on the session needs is dropped here rather than filtered by the
 * client. `levels` must be the *whole* catalogue, inactive items included — an
 * item deactivated after generation is still sitting in parcels and still has
 * to be picked, and leaving it out would silently understate the session.
 */
export function stockRequirementLines(
  levels: readonly { item: StockItem; quantityOnHand: number }[],
  requiredByItem: ReadonlyMap<string, number>,
): StockRequirementLine[] {
  return levels.flatMap((level) => {
    const requiredQuantity = requiredByItem.get(level.item.id);
    if (requiredQuantity === undefined) return [];

    return [
      {
        item: level.item,
        requiredQuantity,
        quantityOnHand: level.quantityOnHand,
        shortfall: Math.max(0, requiredQuantity - level.quantityOnHand),
      },
    ];
  });
}
