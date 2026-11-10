/**
 * The surname's settled form, for the administrators' search. Pure, no I/O.
 *
 * `INITIAL_SPEC1.txt`, `#Searching for a referral`: the surname is searched by
 * its beginning, whatever case it is typed in. Both sides of that comparison —
 * the stored surname and the start an administrator types — go through this
 * one function, so they cannot be settled differently.
 *
 * - **`toLowerCase()`, not SQLite's `lower()`**, because SQLite folds ASCII
 *   only and `Ünsal` would never be found by `üns`.
 * - **NFC first**, so an accented letter typed as one character and the same
 *   letter typed as a letter plus a combining accent are the same letter.
 * - **Leading whitespace goes, trailing whitespace stays.** A space is part of
 *   what is searched for — `Di ` is how Di Lima is found without finding Dibb —
 *   so it cannot be trimmed off the typed start. Nothing begins with a space.
 *
 * Not a repeat-referral match, and not to become one: names are deliberately
 * never matched on (`matching.ts`).
 */
export function normaliseSurname(input: string): string {
  return input.normalize('NFC').trimStart().toLowerCase();
}

/**
 * The fewest characters of a surname a search may be made on. A space counts.
 * `INITIAL_SPEC1.txt`, `#Searching for a referral`.
 */
export const SURNAME_SEARCH_MIN_LENGTH = 3;
