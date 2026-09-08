import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError, UnprocessableError } from '../../core/errors.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import type { Patch } from '../../core/types.ts';
import type {
  NewTargetStockListRow,
  TargetStockListRow,
} from '../../db/schema/target-stock-lists.ts';
import type { TargetStockListsRepository } from './target-stock-lists.repository.ts';

export interface ItemTargetStockLine {
  readonly kind: 'item';
  readonly stockItemId: string;
  readonly name: string;
  readonly targetQuantity: number;
}

/**
 * A crate line beside an item line — same snapshot rules apply: `crateId` and
 * `crateName` are stored as they stood when the line was saved, not a live
 * link to the crate. See `INITIAL_SPEC1.txt`, `#Target stock lists and
 * shopping`, and the identical reasoning already settled for item lines
 * (Q46).
 */
export interface CrateTargetStockLine {
  readonly kind: 'crate';
  readonly crateId: string;
  readonly crateName: string;
  readonly targetQuantity: number;
}

export type TargetStockLine = ItemTargetStockLine | CrateTargetStockLine;

/**
 * The one thing this module needs from `stock` module, reached through its
 * service rather than `crates.repository.ts` directly, per this repo's
 * module-boundary rule.
 */
export interface CrateMembershipLookup {
  listMemberStockItemIds(): Promise<ReadonlySet<string>>;
}

export interface TargetStockListsServiceDeps {
  readonly repository: TargetStockListsRepository;
  readonly crates: CrateMembershipLookup;
  readonly clock: Clock;
}

/**
 * A stock item that is currently a crate member is what the crate is bought
 * for, not itself — so a *newly saved* set of lines (a create, or a patch
 * that sends `lines`) may not give it its own individual target. This does
 * not reach backwards: a line already stored for an item before it became a
 * crate member is left exactly as it was — see `parseLines` and the "a patch
 * that omits lines leaves them untouched" behaviour below. Settled in the
 * crates/groupings handoff, section 4; `INITIAL_SPEC1.txt`,
 * `#Target stock lists and shopping`.
 */
async function assertNoCrateMemberHasAnIndividualTarget(
  crates: CrateMembershipLookup,
  lines: readonly TargetStockLine[],
): Promise<void> {
  const itemLines = lines.filter((line): line is ItemTargetStockLine => line.kind === 'item');
  if (itemLines.length === 0) return;

  const memberIds = await crates.listMemberStockItemIds();
  const offending = itemLines.find((line) => memberIds.has(line.stockItemId));
  if (offending !== undefined) {
    throw new UnprocessableError(
      'A stock item that is currently a crate member cannot be given an individual target',
    );
  }
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
export function createTargetStockListsService({
  repository,
  crates,
  clock,
}: TargetStockListsServiceDeps) {
  async function listTargetStockLists(): Promise<TargetStockListRow[]> {
    return repository.listTargetStockLists();
  }

  async function createTargetStockList(input: {
    name: string;
    lines: TargetStockLine[];
  }): Promise<TargetStockListRow> {
    await assertNoCrateMemberHasAnIndividualTarget(crates, input.lines);
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
    if (patch.lines !== undefined) {
      await assertNoCrateMemberHasAnIndividualTarget(crates, patch.lines);
    }

    const next: Patch<NewTargetStockListRow> = { updatedAt: clock.nowIso() };
    if (patch.name !== undefined) next.name = patch.name;
    // Lines replace wholesale, like the household grid — a list is edited and
    // saved as one document, never line by line, so there is one write and no
    // window in which a list is half updated on a database with no
    // interactive transactions. Only a sent `lines` array is checked against
    // current crate membership above — a patch that omits `lines` leaves
    // whatever is already stored untouched, including a line that predates a
    // stock item becoming a crate member.
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

/**
 * A stored line with no `kind` predates the crate-line addition and is read
 * back as `'item'` — every line saved before this was one, so there is
 * nothing to reconcile, only a field that was never there to begin with.
 */
export function parseLines(linesJson: string): TargetStockLine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(linesJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const lines: TargetStockLine[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;

    if (record.kind === 'crate') {
      if (
        typeof record.crateId === 'string' &&
        typeof record.crateName === 'string' &&
        typeof record.targetQuantity === 'number'
      ) {
        lines.push({
          kind: 'crate',
          crateId: record.crateId,
          crateName: record.crateName,
          targetQuantity: record.targetQuantity,
        });
      }
      continue;
    }

    if (
      typeof record.stockItemId === 'string' &&
      typeof record.name === 'string' &&
      typeof record.targetQuantity === 'number'
    ) {
      lines.push({
        kind: 'item',
        stockItemId: record.stockItemId,
        name: record.name,
        targetQuantity: record.targetQuantity,
      });
    }
  }
  return lines;
}
