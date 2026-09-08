/**
 * Splitting one counted crate across its members. Pure and I/O-free — the
 * service loads the crate and its members, this turns a single entered figure
 * into the per-item deltas that feed the ordinary stock-take pipeline.
 */

export interface CrateDecompositionInput {
  readonly sizePerCrate: number;
  readonly members: readonly { stockItemId: string; stockCompositionPercent: number }[];
}

export interface DecomposedCount {
  readonly stockItemId: string;
  readonly countedQuantity: number;
}

/**
 * `round(enteredCount * sizePerCrate * memberPercent / 100)` per member, using
 * **stock** composition — the shopping table only matters to the client's
 * shortfall split, never to what lands on the shelf.
 *
 * Independent per member: nothing here corrects the small drift that
 * independent rounding can leave between the sum of the parts and
 * `enteredCount * sizePerCrate`. That drift, if any, is the cost of every
 * member having a stable, individually-explicable figure rather than one that
 * shifts to make a total add up.
 */
export function decomposeCrateCount(
  crate: CrateDecompositionInput,
  enteredCount: number,
): DecomposedCount[] {
  return crate.members.map((member) => ({
    stockItemId: member.stockItemId,
    countedQuantity: Math.round(
      (enteredCount * crate.sizePerCrate * member.stockCompositionPercent) / 100,
    ),
  }));
}
