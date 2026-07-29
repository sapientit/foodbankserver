/**
 * Unique-constraint detection.
 *
 * D1 has no interactive transactions, so several invariants in this system are
 * enforced by a unique index rather than by a read-then-write in a service.
 * The most important is the stock ledger's idempotency guard: a team lead
 * double-submitting attendance must move stock exactly once, and the second
 * write failing on that index is what guarantees it. So this predicate has to
 * be right, and it has two non-obvious properties.
 *
 * **1. The constraint message is not on the thrown error.** Drizzle wraps D1
 * failures, so `error.message` is `Failed query: insert into …`. The SQLite
 * text lives further down the `cause` chain:
 *
 * ```
 * [0] Failed query: insert into "stock_ledger" (…)   ← Drizzle wrapper
 * [1] D1_ERROR: UNIQUE constraint failed: stock_ledger.parcel_id, …
 * [2] UNIQUE constraint failed: stock_ledger.parcel_id, …
 * ```
 *
 * **2. SQLite names the columns, not the index.** Even for a named unique
 * index, the message is `UNIQUE constraint failed: table.column, table.column`.
 * Matching on an index name never fires.
 */

const UNIQUE_MARKER = 'UNIQUE constraint failed';

/** Every message in the `cause` chain, outermost first. */
function messageChain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;

  // Bounded so a cyclic cause cannot spin.
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    messages.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return messages;
}

/**
 * True when the failure is a unique violation naming **every** given column.
 *
 * Columns are `table.column` as SQLite reports them, for example
 * `stock_ledger.parcel_id`. Naming all the columns of a composite index is
 * what stops this matching an unrelated constraint on the same table and
 * turning a real bug into a silent success.
 *
 * With no columns, matches any unique violation — prefer the specific form.
 */
export function isUniqueViolation(error: unknown, ...columns: readonly string[]): boolean {
  const violation = messageChain(error).find((message) => message.includes(UNIQUE_MARKER));
  if (violation === undefined) return false;

  return columns.every((column) => violation.includes(column));
}

/** True for any unique violation, regardless of which constraint. */
export function isAnyUniqueViolation(error: unknown): boolean {
  return isUniqueViolation(error);
}
