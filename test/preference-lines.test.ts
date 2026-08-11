import { describe, expect, it } from 'vitest';
import { NEEDS_ATTENTION_QUANTITY } from '../src/db/schema/pick-lists.ts';
import {
  mergePreferenceLines,
  type ParcelContentLine,
} from '../src/modules/pick-lists/preference-lines.ts';

const BEANS = 'item-beans';
const PASTA = 'item-pasta';
const CEREAL = 'item-cereal';

function line(stockItemId: string, quantity: number): ParcelContentLine {
  return { stockItemId, quantity };
}

describe('mergePreferenceLines', () => {
  it('takes the preference over the model when the preference asks for more', () => {
    const result = mergePreferenceLines([line(BEANS, 2)], [line(BEANS, 5)]);
    expect(result).toEqual([line(BEANS, 5)]);
  });

  it('never lowers a model quantity when the preference asks for less', () => {
    const result = mergePreferenceLines([line(BEANS, 5)], [line(BEANS, 2)]);
    expect(result).toEqual([line(BEANS, 5)]);
  });

  it('adds an item the model does not have', () => {
    const result = mergePreferenceLines([line(BEANS, 2)], [line(CEREAL, 3)]);
    expect(result).toEqual([line(BEANS, 2), line(CEREAL, 3)]);
  });

  it('keeps a model item the preferences do not mention', () => {
    const result = mergePreferenceLines([line(BEANS, 2), line(PASTA, 4)], [line(CEREAL, 1)]);
    expect(result).toEqual([line(BEANS, 2), line(CEREAL, 1), line(PASTA, 4)]);
  });

  it('a needs-attention preference beats a higher model quantity', () => {
    const result = mergePreferenceLines([line(BEANS, 5)], [line(BEANS, NEEDS_ATTENTION_QUANTITY)]);
    expect(result).toEqual([line(BEANS, NEEDS_ATTENTION_QUANTITY)]);
  });

  it('a needs-attention preference beats a lower model quantity too', () => {
    // The rule is "beats any number, in either direction" — not just "wins
    // ties" or "wins when the model is smaller".
    const result = mergePreferenceLines([line(BEANS, 1)], [line(BEANS, NEEDS_ATTENTION_QUANTITY)]);
    expect(result).toEqual([line(BEANS, NEEDS_ATTENTION_QUANTITY)]);
  });

  it('treats a needs-attention line the same whichever side it arrives on', () => {
    // Unreachable through the real call path — a model parcel's quantities are
    // positive by schema — but this is an exported pure function, and one that
    // honoured -1 in one argument and silently zeroed it in the other would be
    // a trap for its next caller.
    const result = mergePreferenceLines([line(BEANS, NEEDS_ATTENTION_QUANTITY)], [line(BEANS, 5)]);
    expect(result).toEqual([line(BEANS, NEEDS_ATTENTION_QUANTITY)]);
  });

  it('produces exactly one line per stock item, however many times it is named', () => {
    // Two model entries and two preference entries for the same item: still
    // one line out. `parcel_lines` is uniquely indexed on (parcel_id,
    // stock_item_id) with no ON CONFLICT, so a duplicate here would fail the
    // whole atomic batch on the endpoint a team lead opens first.
    const result = mergePreferenceLines(
      [line(BEANS, 2), line(BEANS, 6)],
      [line(BEANS, 3), line(BEANS, 4)],
    );
    expect(result).toEqual([line(BEANS, 6)]);
  });

  it('is independent of input order', () => {
    const forward = mergePreferenceLines(
      [line(BEANS, 2), line(PASTA, 4)],
      [line(CEREAL, 1), line(BEANS, 9)],
    );
    const backward = mergePreferenceLines(
      [line(PASTA, 4), line(BEANS, 2)],
      [line(BEANS, 9), line(CEREAL, 1)],
    );
    expect(forward).toEqual(backward);
  });

  it('returns the model unchanged when there are no preferences', () => {
    const result = mergePreferenceLines([line(BEANS, 2), line(PASTA, 4)], []);
    expect(result).toEqual([line(BEANS, 2), line(PASTA, 4)]);
  });

  it('returns the preferences unchanged when the model is empty', () => {
    const result = mergePreferenceLines([], [line(BEANS, 2), line(PASTA, 4)]);
    expect(result).toEqual([line(BEANS, 2), line(PASTA, 4)]);
  });

  it('returns nothing when both inputs are empty', () => {
    expect(mergePreferenceLines([], [])).toEqual([]);
  });
});
