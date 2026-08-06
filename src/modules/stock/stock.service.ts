import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Patch } from '../../core/types.ts';
import type { Database } from '../../db/client.ts';
import type { NewStockItem, StockItem } from '../../db/schema/stock.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import { shelfSortKey } from './shelf-sort.ts';
import type { StockLevel, StockRepository } from './stock.repository.ts';

export interface StockServiceDeps {
  readonly db: Database;
  readonly repository: StockRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface StockCountInput {
  readonly stockItemId: string;
  readonly countedQuantity: number;
}

export function createStockService({ db, repository, clock, logger }: StockServiceDeps) {
  async function getItem(id: string): Promise<StockItem> {
    const item = await repository.findItemById(id);
    if (item === undefined) {
      throw new NotFoundError('Stock item not found');
    }
    return item;
  }

  async function createItem(input: { name: string; shelfNumber: string }): Promise<StockItem> {
    const now = clock.nowIso();

    try {
      return await repository.insertItem({
        id: crypto.randomUUID(),
        name: input.name,
        nameNormalised: input.name.trim().toLowerCase(),
        shelfNumber: input.shelfNumber,
        shelfSortKey: shelfSortKey(input.shelfNumber),
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
    patch: Patch<NewStockItem> & { name?: string | undefined; shelfNumber?: string | undefined },
  ): Promise<StockItem> {
    const next: Patch<NewStockItem> = { ...patch, updatedAt: clock.nowIso() };

    // Both derived columns must move with the value they are derived from,
    // or the list silently sorts or matches on stale data.
    if (patch.name !== undefined) next.nameNormalised = patch.name.trim().toLowerCase();
    if (patch.shelfNumber !== undefined) next.shelfSortKey = shelfSortKey(patch.shelfNumber);

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
   */
  async function recordStockTake(
    counts: readonly StockCountInput[],
    actor: Actor,
  ): Promise<{ applied: number; levels: { stockItemId: string; quantityOnHand: number }[] }> {
    // Fail before writing anything if an item does not exist. One query per
    // item, but a page is 40 and this is the only chance to refuse cleanly —
    // the batch below is atomic, so a bad id must not reach it.
    for (const count of counts) {
      await getItem(count.stockItemId);
    }

    const now = clock.nowIso();
    const stockItemIds = counts.map((count) => count.stockItemId);
    const baselines = counts
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
              actorUserId: actor.userId,
              occurredAt: now,
            }),
          ]),
    ]);

    logger.info('recorded a stock take page', {
      count: counts.length,
      userId: actor.userId,
    });

    return {
      applied: counts.length,
      // The level after the save is the counted figure by construction: every
      // other row for that item has just been deleted. No query needed.
      levels: counts.map((count) => ({
        stockItemId: count.stockItemId,
        quantityOnHand: count.countedQuantity,
      })),
    };
  }

  return {
    getItem,
    listItems: (activeOnly: boolean) => repository.listItems(activeOnly),
    listLevels: (activeOnly: boolean): Promise<StockLevel[]> => repository.listLevels(activeOnly),
    searchItems: (term: string) => repository.searchItems(term),
    createItem,
    updateItem,
    recordStockTake,
  };
}

export type StockService = ReturnType<typeof createStockService>;
