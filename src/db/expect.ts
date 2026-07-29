/**
 * Row-count assertions.
 *
 * `noUncheckedIndexedAccess` means `rows[0]` is `T | undefined` everywhere, so
 * every query result needs narrowing. These helpers do it once, with a message
 * that says which query went wrong, rather than scattering non-null assertions
 * that CLAUDE.md forbids.
 */

import { NotFoundError } from '../core/errors.ts';

/** The single expected row, or a 404. `what` is a description, never a value. */
export function expectOne<T>(rows: readonly T[], what: string): T {
  const first = rows[0];
  if (first === undefined) {
    throw new NotFoundError(`${what} not found`);
  }
  return first;
}

/** The first row if present, otherwise undefined. Never throws. */
export function expectAtMostOne<T>(rows: readonly T[]): T | undefined {
  return rows[0];
}

/**
 * Asserts a write touched the number of rows it was supposed to.
 *
 * On D1 this is how a guarded conditional write reports its outcome: there is
 * no transaction to roll back, so `meta.changes` is the result.
 */
export function expectChanges(actual: number, expected: number, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${String(expected)} row(s) changed, got ${String(actual)}`);
  }
}
