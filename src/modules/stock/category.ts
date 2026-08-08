/**
 * Settling the capitalisation of a stock item's category.
 *
 * A category is free text — there are few enough of them that a lookup table
 * would be one more maintenance screen for no gain. The cost of free text is
 * that `tinned goods`, `Tinned Goods` and `TINNED GOODS` are three different
 * strings, and the maintenance and pick-list screens group by that string, so
 * they would show three groups where the administrator meant one.
 *
 * So the capitalisation is settled on write and **nothing else is**. Two
 * spellings that differ by more than case — `Tins` and `Tinned` — are two
 * categories, deliberately: guessing that they meant the same thing is the kind
 * of helpfulness that silently merges two groups an administrator wanted apart.
 *
 * Runs of whitespace collapse for the same reason the case does. Two spaces
 * between words are invisible on screen, so `Tinned  Goods` would sit in the
 * list looking exactly like `Tinned Goods` and behaving like a different
 * category — the same fault as the casing, reached by a different character.
 *
 * **The trade-off, so it is not rediscovered as a bug:** forcing the case is
 * what makes the collisions impossible, and it also lowercases acronyms, so
 * `UHT milk` is stored as `Uht Milk`. Leaving an all-capitals word alone would
 * read better and would bring the collisions straight back — `UHT milk` and
 * `uht milk` would be two categories again.
 *
 * Pure, so the rule is testable on its own, and idempotent: settling an
 * already-settled category returns it unchanged.
 */

const WHITESPACE_RUN = /\s+/;

/** `tinned goods` → `Tinned Goods`. */
export function standardiseCategory(category: string): string {
  return category
    .trim()
    .split(WHITESPACE_RUN)
    .map(capitaliseWord)
    .filter((word) => word !== '')
    .join(' ');
}

/**
 * The first letter of a word up, the rest down.
 *
 * The first *letter*, not the first character: a category may begin with a
 * bracket or a number, and `(baby) food` should still come out `(Baby) Food`.
 */
function capitaliseWord(word: string): string {
  const lowered = word.toLowerCase();
  const firstLetter = lowered.search(/\p{L}/u);
  if (firstLetter === -1) return lowered;

  return (
    lowered.slice(0, firstLetter) +
    lowered.charAt(firstLetter).toUpperCase() +
    lowered.slice(firstLetter + 1)
  );
}
