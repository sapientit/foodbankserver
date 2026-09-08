import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Patch } from '../../core/types.ts';
import type { Database } from '../../db/client.ts';
import type { NewStockItem, StockItem } from '../../db/schema/stock.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import { standardiseCategory } from './category.ts';
import { decomposeCrateCount } from './crate-decomposition.ts';
import type { CratesRepository } from './crates.repository.ts';
import { shelfSortKey } from './shelf-sort.ts';
import { computeStockValidationIssues, type StockValidationIssue } from './stock-validation.ts';
import type { StockLevel, StockRepository } from './stock.repository.ts';
import { MAX_COUNTED_QUANTITY, type StockOrder } from './stock.schema.ts';

/** The seeded grouping every existing item was backfilled into — migration `0034`. */
export const NON_PERISHABLE_GROUPING_ID = '4c55e811-9b7c-482c-ab4c-a700876d49bd';

export interface StockServiceDeps {
  readonly db: Database;
  readonly repository: StockRepository;
  readonly cratesRepository: CratesRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface StockCountInput {
  readonly stockItemId: string;
  readonly countedQuantity: number;
}

export interface CrateCountInput {
  readonly crateId: string;
  readonly enteredCount: number;
}

/**
 * Who a counted page is stamped against. A signed-in team lead supplies their
 * own id; a volunteer counting on a code supplies the team lead who issued it
 * (`INITIAL_SPEC1.txt`, #Stock maintenance — "recorded against the team leader
 * who gave it out"). Either way it is a real `users` row, so the ledger's
 * `actor_user_id` foreign key holds.
 */
export interface StockTakeCounter {
  readonly actorUserId: string;
}

export function createStockService({
  db,
  repository,
  cratesRepository,
  clock,
  logger,
}: StockServiceDeps) {
  async function getItem(id: string): Promise<StockItem> {
    const item = await repository.findItemById(id);
    if (item === undefined) {
      throw new NotFoundError('Stock item not found');
    }
    return item;
  }

  /**
   * `groupingId` is a foreign key an administrator types or picks from a
   * list that can go stale, so an unknown id must refuse cleanly here —
   * otherwise it surfaces as a raw D1 foreign-key violation, the same trap
   * `referrals.service.ts` calls out for `reasonId`. `null` is always valid
   * (a crate member) and skips the check entirely.
   */
  async function assertGroupingExists(groupingId: string | null): Promise<void> {
    if (groupingId === null) return;
    if (!(await cratesRepository.groupingExists(groupingId))) {
      throw new BadRequestError('Unknown grouping');
    }
  }

  async function createItem(input: {
    name: string;
    category: string;
    description?: string | undefined;
    shelfNumber: string;
    lowStockThreshold?: number | null | undefined;
    groupingId?: string | null | undefined;
    unitsPerPack?: number | null | undefined;
    packUnitLabel?: string | null | undefined;
  }): Promise<StockItem> {
    const now = clock.nowIso();
    // Omitted entirely means "directly grouped, and no opinion on which
    // grouping" — the seeded default, always valid. An explicit `null` (a
    // crate member) is left as `null` rather than defaulted.
    const groupingId =
      input.groupingId === undefined ? NON_PERISHABLE_GROUPING_ID : input.groupingId;
    if (input.groupingId !== undefined) await assertGroupingExists(groupingId);

    try {
      return await repository.insertItem({
        id: crypto.randomUUID(),
        name: input.name,
        nameNormalised: input.name.trim().toLowerCase(),
        category: standardiseCategory(input.category),
        description: emptyToNull(input.description),
        shelfNumber: input.shelfNumber,
        shelfSortKey: shelfSortKey(input.shelfNumber),
        lowStockThreshold: input.lowStockThreshold ?? null,
        groupingId,
        unitsPerPack: input.unitsPerPack ?? null,
        packUnitLabel: normalisePackUnitLabel(input.unitsPerPack ?? null, input.packUnitLabel),
        isActive: 1,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'stock_items.name_normalised')) {
        throw new ConflictError('A stock item with that name already exists', { cause: error });
      }
      throw error;
    }
  }

  async function updateItem(
    id: string,
    patch: Patch<NewStockItem> & {
      name?: string | undefined;
      category?: string | undefined;
      description?: string | null | undefined;
      shelfNumber?: string | undefined;
      unitsPerPack?: number | null | undefined;
      packUnitLabel?: string | null | undefined;
    },
  ): Promise<StockItem> {
    if (patch.groupingId !== undefined) await assertGroupingExists(patch.groupingId);

    const next: Patch<NewStockItem> = { ...patch, updatedAt: clock.nowIso() };

    // Both derived columns must move with the value they are derived from,
    // or the list silently sorts or matches on stale data.
    if (patch.name !== undefined) next.nameNormalised = patch.name.trim().toLowerCase();
    if (patch.shelfNumber !== undefined) next.shelfSortKey = shelfSortKey(patch.shelfNumber);

    // The category is settled the same way on amendment as on creation, or an
    // administrator correcting a typo would be the one person who can create a
    // second group that looks identical to the first.
    if (patch.category !== undefined) next.category = standardiseCategory(patch.category);
    if (patch.description !== undefined) next.description = emptyToNull(patch.description);

    // `packUnitLabel` only needs touching in two cases: the label itself was
    // sent (normalise it against whichever `unitsPerPack` applies), or
    // `unitsPerPack` is being cleared and the label was not mentioned (clear
    // it too, so a stale label never survives on an item with no packing
    // size). Setting `unitsPerPack` to a positive number with no label sent
    // leaves the stored label alone — the invariant already guarantees it was
    // `null` if `unitsPerPack` was previously `null`.
    if (patch.packUnitLabel !== undefined) {
      const unitsPerPack =
        patch.unitsPerPack === undefined ? (await getItem(id)).unitsPerPack : patch.unitsPerPack;
      next.packUnitLabel = normalisePackUnitLabel(unitsPerPack, patch.packUnitLabel);
    } else if (patch.unitsPerPack === null) {
      next.packUnitLabel = null;
    }

    const updated = await repository.updateItem(id, next);
    if (updated === undefined) {
      throw new NotFoundError('Stock item not found');
    }
    return updated;
  }

  /**
   * Saves one page of a stock take.
   *
   * **The count is the truth.** For every item in the page, whatever the ledger
   * held for it is deleted and replaced by a single `opening_balance` at the
   * counted figure — so the item's level afterwards *is* the number the
   * volunteer typed, with no arithmetic and no variance to reconcile.
   *
   * ## Only the changed items arrive
   *
   * The client sends the items whose number the volunteer altered and leaves
   * the rest out. An item that is not sent is not touched, which means it was
   * either counted and found correct or never counted — the charity decided
   * they are content not to tell those apart, so do not add a flag to
   * distinguish them.
   *
   * ## Repeating a save is safe
   *
   * The delete removes what a previous identical save wrote, so sending a page
   * twice leaves the same rows behind. That is idempotence by construction
   * rather than by a guard, which is why there is no unique index here and no
   * conflict to catch. It is **last-write-wins**, not apply-once: a stale page
   * saved late will overwrite a newer count, and a parcel issued between two
   * identical saves is lost. Nothing else is meant to touch stock during a
   * count, and the next count restates everything from the shelf.
   *
   * ## A count of zero writes nothing
   *
   * `stock_ledger` has a CHECK that a delta is never zero, and rightly — a row
   * saying nothing happened is noise. An item counted as zero therefore gets
   * its history deleted and no baseline, which leaves `SUM(quantity_delta)`
   * over no rows, which is zero. The right answer falls out of doing less.
   *
   * ## Crate counts
   *
   * `crateCounts` is decomposed into the same shape as a direct count —
   * `crate-decomposition.ts` — and fed through the identical pipeline below,
   * so a counted crate gets "zero writes nothing" and the delete-then-insert
   * atomicity for free. **A stock item named by more than one source in the
   * same page is rejected**, whether that is a direct count colliding with a
   * crate, or two crates sharing a member: the server has no basis for
   * picking one figure over the other, the same reasoning
   * `stockTakeCountsSchema` already applies to two direct counts for one item.
   */
  async function recordStockTake(
    counts: readonly StockCountInput[],
    crateCounts: readonly CrateCountInput[],
    counter: StockTakeCounter,
  ): Promise<{ applied: number; levels: { stockItemId: string; quantityOnHand: number }[] }> {
    // Fail before writing anything if an item does not exist. One query per
    // item, but a page is 40 and this is the only chance to refuse cleanly —
    // the batch below is atomic, so a bad id must not reach it.
    for (const count of counts) {
      await getItem(count.stockItemId);
    }

    const decomposed: StockCountInput[] = [];
    if (crateCounts.length > 0) {
      const crates = await cratesRepository.listCratesWithMembers();
      const cratesById = new Map(crates.map((entry) => [entry.crate.id, entry]));

      for (const crateCount of crateCounts) {
        const entry = cratesById.get(crateCount.crateId);
        if (entry === undefined) {
          throw new NotFoundError('Crate not found');
        }
        const memberCounts = decomposeCrateCount(
          {
            sizePerCrate: entry.crate.sizePerCrate,
            members: entry.members.map((member) => ({
              stockItemId: member.stockItemId,
              stockCompositionPercent: member.stockCompositionPercent,
            })),
          },
          crateCount.enteredCount,
        );
        // `sizePerCrate * enteredCount` is not bounded the way a direct
        // count's `countedQuantity` is, so a decomposed figure needs its own
        // check against the same ceiling — otherwise a large crate could
        // write a ledger delta a direct count could never produce.
        for (const memberCount of memberCounts) {
          if (memberCount.countedQuantity > MAX_COUNTED_QUANTITY) {
            throw new BadRequestError('A crate count decomposed to a quantity that is too large');
          }
        }
        decomposed.push(...memberCounts);
      }
    }

    const combined = [...counts, ...decomposed];
    const touched = new Set<string>();
    for (const entry of combined) {
      if (touched.has(entry.stockItemId)) {
        throw new BadRequestError(
          'A stock item cannot be set by more than one direct or crate count in the same request',
        );
      }
      touched.add(entry.stockItemId);
    }

    const now = clock.nowIso();
    const stockItemIds = combined.map((count) => count.stockItemId);
    const baselines = combined
      .filter((count) => count.countedQuantity > 0)
      .map((count) => ({
        id: crypto.randomUUID(),
        stockItemId: count.stockItemId,
        quantityDelta: count.countedQuantity,
      }));

    // One batch: the delete and the insert are atomic together, or an item
    // reads as zero to anyone looking in between.
    await db.$client.batch([
      repository.buildDeleteHistoryFor(stockItemIds),
      ...(baselines.length === 0
        ? []
        : [
            repository.buildInsertBaselines(baselines, {
              actorUserId: counter.actorUserId,
              occurredAt: now,
            }),
          ]),
    ]);

    logger.info('recorded a stock take page', {
      count: combined.length,
      userId: counter.actorUserId,
    });

    return {
      applied: counts.length + crateCounts.length,
      // The level after the save is the counted figure by construction: every
      // other row for that item has just been deleted. No query needed.
      levels: combined.map((count) => ({
        stockItemId: count.stockItemId,
        quantityOnHand: count.countedQuantity,
      })),
    };
  }

  /**
   * A team lead's hand correction to one item's level, between one stock take
   * and the next. Unlike `recordStockTake`, this is a direct ledger insert,
   * not a delete-then-insert: there is no prior state to reconcile, only a
   * signed amount to add to whatever the ledger already holds. No reason is
   * recorded and **no actor is stamped on the row** — `INITIAL_SPEC1.txt`,
   * "#Stock maintenance" is explicit that "nothing is kept about why it
   * happened or who made it", unlike a stock take's baseline or a parcel
   * issue, which do carry `actorUserId`. `actor` is taken only so the access
   * log below can name who called the route; it never reaches the ledger.
   */
  async function applyCorrection(
    stockItemId: string,
    quantityDelta: number,
    actor: Actor,
  ): Promise<{ quantityOnHand: number }> {
    await getItem(stockItemId); // 404s if unknown, same as everywhere else in this service

    const now = clock.nowIso();
    await repository.insertCorrection({
      id: crypto.randomUUID(),
      stockItemId,
      quantityDelta,
      occurredAt: now,
    });

    const quantityOnHand = await repository.levelFor(stockItemId);
    logger.info('applied a stock correction', { stockItemId, userId: actor.userId });
    return { quantityOnHand };
  }

  /**
   * The non-blocking consistency report behind `GET /stock/validation`. Loads
   * every item (active and inactive) and every crate with its members, then
   * hands plain data to the pure `computeStockValidationIssues`. Inactive items
   * are loaded only so the pure function knows a crate member still exists;
   * they take no part in any check — see `stock-validation.ts`.
   */
  async function computeValidationIssues(): Promise<StockValidationIssue[]> {
    const [items, crateEntries] = await Promise.all([
      repository.listItems(false, 'shelf'),
      cratesRepository.listCratesWithMembers(),
    ]);

    return computeStockValidationIssues(
      items.map((item) => ({
        id: item.id,
        name: item.name,
        shelfNumber: item.shelfNumber,
        groupingId: item.groupingId,
        isActive: item.isActive === 1,
      })),
      crateEntries.map((entry) => ({
        id: entry.crate.id,
        name: entry.crate.name,
        shelfKey: entry.crate.shelfKey,
      })),
      crateEntries.flatMap((entry) =>
        entry.members.map((member) => ({
          crateId: entry.crate.id,
          stockItemId: member.stockItemId,
        })),
      ),
    );
  }

  return {
    getItem,
    listItems: (activeOnly: boolean, order: StockOrder) => repository.listItems(activeOnly, order),
    listLevels: (activeOnly: boolean, order: StockOrder): Promise<StockLevel[]> =>
      repository.listLevels(activeOnly, order),
    searchItems: (term: string) => repository.searchItems(term),
    createItem,
    updateItem,
    recordStockTake,
    applyCorrection,
    countLowStock: () => repository.countLowStock(),
    computeValidationIssues,
  };
}

export type StockService = ReturnType<typeof createStockService>;

/**
 * No description and an empty one are the same thing.
 *
 * Zod trims, so a client that sends a field of spaces arrives here as `''`.
 * Storing that would put a blank line on a printed sheet and give the
 * maintenance screen a value it cannot tell from absence, so it becomes the
 * absent column — an explicit `null`, per the repo's convention.
 */
function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/**
 * `packUnitLabel` only ever means something alongside `unitsPerPack`: absent
 * units forces the label to `null` regardless of what was supplied, and a
 * blank label given alongside real units is the same as no label at all — the
 * client reads either as "packs".
 */
function normalisePackUnitLabel(
  unitsPerPack: number | null,
  label: string | null | undefined,
): string | null {
  if (unitsPerPack === null) return null;
  return emptyToNull(label);
}
