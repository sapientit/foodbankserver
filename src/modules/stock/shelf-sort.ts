/**
 * Sorting shelf numbers the way a person walking the warehouse expects.
 *
 * Shelves are labelled by people, so they are alphanumeric: `A1`, `A2`, `A10`,
 * `12b`. Sorting those as plain text puts `A10` before `A2`, which sends a
 * picker up and down the aisle. Splitting into alphabetic and numeric runs and
 * zero-padding the numbers fixes it.
 *
 * Computed on write and stored, because expressing it in SQL would be
 * unreadable and would have to be repeated in every query that orders by
 * shelf. Pure, so the ordering rules are testable on their own.
 */

/** Wide enough for any real shelf number; keeps every key the same shape. */
const NUMERIC_WIDTH = 6;

const RUN_PATTERN = /\d+|\D+/g;

/**
 * A sortable key for a shelf number.
 *
 * `A2` → `a|000002`, `A10` → `a|000010`, so ordinary string ordering puts them
 * in walking order. The separator keeps a numeric run from merging with the
 * alphabetic one beside it.
 */
export function shelfSortKey(shelfNumber: string): string {
  const normalised = shelfNumber.trim().toLowerCase();
  if (normalised === '') return '';

  const runs = normalised.match(RUN_PATTERN) ?? [];

  return runs
    .map((run) =>
      /^\d+$/.test(run)
        ? // Strip leading zeros first so '007' and '7' sort identically.
          run.replace(/^0+(?=\d)/, '').padStart(NUMERIC_WIDTH, '0')
        : run.trim(),
    )
    .filter((part) => part !== '')
    .join('|');
}

/** Comparator for shelf numbers, for sorting in memory. */
export function compareShelfNumbers(a: string, b: string): number {
  const keyA = shelfSortKey(a);
  const keyB = shelfSortKey(b);
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}
