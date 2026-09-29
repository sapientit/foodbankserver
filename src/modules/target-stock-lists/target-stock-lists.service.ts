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
  listCrateIdsByMemberStockItemId(): Promise<ReadonlyMap<string, readonly string[]>>;
}

export interface TargetStockListsServiceDeps {
  readonly repository: TargetStockListsRepository;
  readonly crates: CrateMembershipLookup;
  readonly clock: Clock;
}

/**
 * A newly saved set of lines (a create, or a patch that sends `lines`) may
 * give a crate member its own individual target, or give its crate one, but
 * not both — the item would be bought twice over. An item in more than one
 * crate is refused if any of them is on the list. This applies to every sent
 * line, including a pair already stored together before the item joined the
 * crate: a list with both cannot be saved again until the administrator
 * removes one. A patch that omits `lines` checks nothing and leaves the
 * stored lines untouched. `INITIAL_SPEC1.txt`, `#Target stock lists and
 * shopping`.
 *
 * Membership is only read when the payload has both kinds of line — an
 * item-only or crate-only list cannot contain the pair.
 */
async function assertNoItemTargetedAlongsideItsCrate(
  crates: CrateMembershipLookup,
  lines: readonly TargetStockLine[],
): Promise<void> {
  const itemLines = lines.filter((line): line is ItemTargetStockLine => line.kind === 'item');
  const targetedCrateIds = new Set(
    lines.filter((line) => line.kind === 'crate').map((line) => line.crateId),
  );
  if (itemLines.length === 0 || targetedCrateIds.size === 0) return;

  const crateIdsByItem = await crates.listCrateIdsByMemberStockItemId();
  const offending = itemLines.find((line) =>
    (crateIdsByItem.get(line.stockItemId) ?? []).some((crateId) => targetedCrateIds.has(crateId)),
  );
  if (offending !== undefined) {
    throw new UnprocessableError(
      'A stock item cannot have an individual target on a list that also targets its crate',
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
    await assertNoItemTargetedAlongsideItsCrate(crates, input.lines);
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
      await assertNoItemTargetedAlongsideItsCrate(crates, patch.lines);
    }

    const next: Patch<NewTargetStockListRow> = { updatedAt: clock.nowIso() };
    if (patch.name !== undefined) next.name = patch.name;
    // Lines replace wholesale, like the household grid — a list is edited and
    // saved as one document, never line by line, so there is one write and no
    // window in which a list is half updated on a database with no
    // interactive transactions. Only a sent `lines` array is checked against
    // current crate membership above — a patch that omits `lines` leaves
    // whatever is already stored untouched.
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
