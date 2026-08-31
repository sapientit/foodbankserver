import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import type { Patch } from '../../core/types.ts';
import type {
  NewTargetStockListRow,
  TargetStockListRow,
} from '../../db/schema/target-stock-lists.ts';
import type { TargetStockListsRepository } from './target-stock-lists.repository.ts';

export interface TargetStockLine {
  readonly stockItemId: string;
  readonly name: string;
  readonly targetQuantity: number;
}

export interface TargetStockListsServiceDeps {
  readonly repository: TargetStockListsRepository;
  readonly clock: Clock;
}

/**
 * Named standing target stock lists.
 *
 * **Lines are stored exactly as sent, never validated against the stock item
 * table.** A line's `stockItemId` and `name` are a snapshot, not a live
 * reference — see `INITIAL_SPEC1.txt`, `#Target stock lists and shopping`,
 * settled 2026-08-31 (was Q46). Rejecting an unknown or retired id here, or
 * quietly rewriting `name` to match the current catalogue, would defeat the
 * point: a list has to keep working, and keep telling an administrator what it
 * used to say, even after the catalogue moves on — the discrepancies this
 * causes are exactly what the client is expected to catch and surface, not a
 * side effect to be engineered away.
 */
export function createTargetStockListsService({ repository, clock }: TargetStockListsServiceDeps) {
  async function listTargetStockLists(): Promise<TargetStockListRow[]> {
    return repository.listTargetStockLists();
  }

  async function createTargetStockList(input: {
    name: string;
    lines: TargetStockLine[];
  }): Promise<TargetStockListRow> {
    const now = clock.nowIso();

    try {
      return await repository.insertTargetStockList({
        id: crypto.randomUUID(),
        name: input.name,
        linesJson: JSON.stringify(input.lines),
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'target_stock_lists.name')) {
        throw new ConflictError('A target stock list with that name already exists', {
          cause: error,
        });
      }
      throw error;
    }
  }

  async function updateTargetStockList(
    id: string,
    patch: { name?: string | undefined; lines?: TargetStockLine[] | undefined },
  ): Promise<TargetStockListRow> {
    const next: Patch<NewTargetStockListRow> = { updatedAt: clock.nowIso() };
    if (patch.name !== undefined) next.name = patch.name;
    // Lines replace wholesale, like the household grid — a list is edited and
    // saved as one document, never line by line, so there is one write and no
    // window in which a list is half updated on a database with no
    // interactive transactions.
    if (patch.lines !== undefined) next.linesJson = JSON.stringify(patch.lines);

    try {
      const updated = await repository.updateTargetStockList(id, next);
      if (updated === undefined) {
        throw new NotFoundError('Target stock list not found');
      }
      return updated;
    } catch (error) {
      if (isUniqueViolation(error, 'target_stock_lists.name')) {
        throw new ConflictError('A target stock list with that name already exists', {
          cause: error,
        });
      }
      throw error;
    }
  }

  async function deleteTargetStockList(id: string): Promise<void> {
    await repository.deleteTargetStockList(id); // Idempotent — deleting twice is not an error.
  }

  return {
    listTargetStockLists,
    createTargetStockList,
    updateTargetStockList,
    deleteTargetStockList,
  };
}

export type TargetStockListsService = ReturnType<typeof createTargetStockListsService>;

export function parseLines(linesJson: string): TargetStockLine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(linesJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (entry): entry is TargetStockLine =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).stockItemId === 'string' &&
      typeof (entry as Record<string, unknown>).name === 'string' &&
      typeof (entry as Record<string, unknown>).targetQuantity === 'number',
  );
}
