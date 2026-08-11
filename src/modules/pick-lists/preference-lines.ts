import { NEEDS_ATTENTION_QUANTITY } from '../../db/schema/pick-lists.ts';

export interface ParcelContentLine {
  readonly stockItemId: string;
  readonly quantity: number;
}

/**
 * Merges a household's preference lines into its model parcel's contents.
 *
 * The client evaluates its own preference rules — it owns the referral form
 * definition, so it is the only party that can — and sends the stock items it
 * resolved them to. This decides what that means when both sources name the
 * same item.
 *
 * **A preference asks for _at least_ this much, so the quantity is the higher
 * of the two.** Adding them would double an item a future model parcel happened
 * to contain, and taking the preference's word for it would quietly cut a
 * larger household's share.
 *
 * **A needs-attention line beats any number.** `NEEDS_ATTENTION_QUANTITY` means
 * the rules could not turn the household's answer into a quantity, so a team
 * leader must. If the higher number won instead, the request would vanish
 * behind a model quantity that was chosen for household size and knows nothing
 * about what was asked for — and nobody would ever be told. Attention cannot be
 * lost that way: the parcel cannot be reviewed while it stands, so the decision
 * gets made rather than skipped.
 *
 * At most one line per stock item comes out, whatever goes in. That is not
 * tidiness: `parcel_lines` is uniquely indexed on `(parcel_id, stock_item_id)`
 * and the bulk insert has no `ON CONFLICT`, so a duplicate would fail the whole
 * atomic batch — on the endpoint a team lead opens first thing on a session
 * morning.
 *
 * Distinct from `normaliseContents` in the rules engine, which **sums**: that
 * answers "what does one author's list mean when it names an item twice", and
 * this answers "what do two independent sources mean when they name the same
 * one". Neither calls the other.
 */
export function mergePreferenceLines(
  model: readonly ParcelContentLine[],
  preferences: readonly ParcelContentLine[],
): ParcelContentLine[] {
  const byItem = new Map<string, number>();

  for (const line of [...model, ...preferences]) {
    byItem.set(line.stockItemId, stronger(byItem.get(line.stockItemId), line.quantity));
  }

  return [...byItem.entries()]
    .filter(([, quantity]) => quantity > 0 || quantity === NEEDS_ATTENTION_QUANTITY)
    .map(([stockItemId, quantity]) => ({ stockItemId, quantity }))
    .sort((a, b) => a.stockItemId.localeCompare(b.stockItemId));
}

/**
 * Needs-attention beats any number; otherwise the larger quantity wins.
 *
 * Applied to both sides rather than only to the preferences, so the result does
 * not depend on which argument a line arrived in. A model parcel cannot hold a
 * `-1` today — the rules schema requires a positive quantity — but this is an
 * exported function, and one that quietly turned `-1` into `0` for one of its
 * two arguments would be a trap for the next caller.
 */
function stronger(existing: number | undefined, quantity: number): number {
  if (existing === NEEDS_ATTENTION_QUANTITY || quantity === NEEDS_ATTENTION_QUANTITY) {
    return NEEDS_ATTENTION_QUANTITY;
  }
  return Math.max(existing ?? 0, quantity);
}
