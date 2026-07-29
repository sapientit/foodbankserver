import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Patch } from '../../core/types.ts';
import type { Database } from '../../db/client.ts';
import type { NewStockItem, StockItem, StockTake } from '../../db/schema/stock.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import { shelfSortKey } from './shelf-sort.ts';
import type { StockLevel, StockRepository } from './stock.repository.ts';

export interface StockServiceDeps {
  readonly db: Database;
  readonly repository: StockRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface PurchaseLineInput {
  readonly stockItemId: string;
  readonly quantity: number;
}

export interface CommittedStockTake {
  readonly stockTake: StockTake;
  readonly adjustments: { stockItemId: string; expected: number; counted: number; delta: number }[];
}

export function createStockService({ db, repository, clock, logger }: StockServiceDeps) {
  async function getItem(id: string): Promise<StockItem> {
    const item = await repository.findItemById(id);
    if (item === undefined) {
      throw new NotFoundError('Stock item not found');
    }
    return item;
  }

  async function createItem(input: {
    name: string;
    unit: string;
    shelfNumber: string;
    lowStockThreshold: number | null;
  }): Promise<StockItem> {
    const now = clock.nowIso();

    try {
      return await repository.insertItem({
        id: crypto.randomUUID(),
        name: input.name,
        nameNormalised: input.name.trim().toLowerCase(),
        unit: input.unit,
        shelfNumber: input.shelfNumber,
        shelfSortKey: shelfSortKey(input.shelfNumber),
        lowStockThreshold: input.lowStockThreshold,
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
   * Records a shop: the purchase, its lines, and one ledger entry per line,
   * all in a single `db.batch()`.
   *
   * The purchase guard (`idx_stock_ledger_purchase_movement`) makes a
   * double-tapped save fail on the second attempt rather than adding the
   * shopping twice.
   */
  async function recordPurchase(
    input: {
      purchasedAt?: string | undefined;
      note: string | null;
      lines: readonly PurchaseLineInput[];
    },
    actor: Actor,
  ): Promise<{ purchaseId: string; lines: number }> {
    const now = clock.nowIso();
    const purchaseId = crypto.randomUUID();
    const purchasedAt = input.purchasedAt ?? now;

    // Fail before writing anything if an item does not exist.
    for (const line of input.lines) {
      await getItem(line.stockItemId);
    }

    const statements = [
      repository.buildInsertPurchase({
        id: purchaseId,
        purchasedAt,
        note: input.note,
        createdByUserId: actor.userId,
        createdAt: now,
      }),
      ...input.lines.flatMap((line) => [
        repository.buildInsertPurchaseLine({
          id: crypto.randomUUID(),
          purchaseId,
          stockItemId: line.stockItemId,
          quantity: line.quantity,
        }),
        repository.buildInsertLedgerEntry({
          id: crypto.randomUUID(),
          stockItemId: line.stockItemId,
          quantityDelta: line.quantity,
          movementType: 'purchase',
          parcelId: null,
          sessionId: null,
          purchaseId,
          stockTakeId: null,
          reason: null,
          actorUserId: actor.userId,
          occurredAt: purchasedAt,
          createdAt: now,
        }),
      ]),
    ];

    await db.batch(statements as [(typeof statements)[number], ...typeof statements]);

    logger.info('recorded a shop', {
      purchaseId,
      count: input.lines.length,
      userId: actor.userId,
    });
    return { purchaseId, lines: input.lines.length };
  }

  async function openStockTake(note: string | null, actor: Actor): Promise<StockTake> {
    const now = clock.nowIso();
    return repository.insertStockTake({
      id: crypto.randomUUID(),
      countedAt: now,
      status: 'open',
      note,
      createdByUserId: actor.userId,
      committedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function recordCounts(
    stockTakeId: string,
    counts: readonly { stockItemId: string; countedQuantity: number }[],
  ): Promise<void> {
    const stockTake = await requireOpenStockTake(stockTakeId);

    for (const line of counts) {
      await getItem(line.stockItemId);
      await repository.upsertStockTakeLine({
        id: crypto.randomUUID(),
        stockTakeId: stockTake.id,
        stockItemId: line.stockItemId,
        countedQuantity: line.countedQuantity,
        expectedQuantity: null,
      });
    }
  }

  /**
   * Commits a stock take.
   *
   * The spec says the list is "editable", which read literally means writing a
   * level directly — and that would break the append-only ledger. Instead the
   * count is recorded and committing writes **one adjustment entry per item
   * whose count differs from the derived level**. Same screen for the user,
   * auditable arithmetic, and the discrepancy stays visible rather than being
   * silently absorbed.
   */
  async function commitStockTake(stockTakeId: string, actor: Actor): Promise<CommittedStockTake> {
    const stockTake = await requireOpenStockTake(stockTakeId);
    const lines = await repository.listStockTakeLines(stockTakeId);

    if (lines.length === 0) {
      throw new ConflictError('This stock take has no counts recorded');
    }

    // One query for every level involved, rather than one per line.
    const levels = await repository.levelsFor(lines.map((line) => line.stockItemId));
    const now = clock.nowIso();

    const adjustments = lines
      .map((line) => {
        const expected = levels.get(line.stockItemId) ?? 0;
        return {
          stockItemId: line.stockItemId,
          expected,
          counted: line.countedQuantity,
          delta: line.countedQuantity - expected,
        };
      })
      .filter((adjustment) => adjustment.delta !== 0);

    const statements = [
      ...lines.map((line) =>
        repository.buildRecordExpected(
          stockTakeId,
          line.stockItemId,
          levels.get(line.stockItemId) ?? 0,
        ),
      ),
      ...adjustments.map((adjustment) =>
        repository.buildInsertLedgerEntry({
          id: crypto.randomUUID(),
          stockItemId: adjustment.stockItemId,
          quantityDelta: adjustment.delta,
          movementType: 'stock_take_adjustment',
          parcelId: null,
          sessionId: null,
          purchaseId: null,
          stockTakeId,
          reason: 'Stock take variance',
          actorUserId: actor.userId,
          occurredAt: now,
          createdAt: now,
        }),
      ),
      repository.buildCommitStockTake(stockTakeId, now),
    ];

    await db.batch(statements as [(typeof statements)[number], ...typeof statements]);

    logger.info('committed a stock take', {
      stockTakeId,
      count: adjustments.length,
      userId: actor.userId,
    });

    return { stockTake: { ...stockTake, status: 'committed', committedAt: now }, adjustments };
  }

  /** A one-off correction, donation or wastage. Always carries a reason. */
  async function adjust(
    input: {
      stockItemId: string;
      quantityDelta: number;
      movementType: 'donation' | 'wastage' | 'expiry' | 'correction' | 'opening_balance';
      reason: string;
    },
    actor: Actor,
  ): Promise<void> {
    await getItem(input.stockItemId);
    const now = clock.nowIso();

    await repository.insertLedgerEntry({
      id: crypto.randomUUID(),
      stockItemId: input.stockItemId,
      quantityDelta: input.quantityDelta,
      movementType: input.movementType,
      parcelId: null,
      sessionId: null,
      purchaseId: null,
      stockTakeId: null,
      reason: input.reason,
      actorUserId: actor.userId,
      occurredAt: now,
      createdAt: now,
    });

    logger.info('recorded a stock adjustment', {
      stockItemId: input.stockItemId,
      code: input.movementType,
      userId: actor.userId,
    });
  }

  async function requireOpenStockTake(id: string): Promise<StockTake> {
    const stockTake = await repository.findStockTake(id);
    if (stockTake === undefined) {
      throw new NotFoundError('Stock take not found');
    }
    if (stockTake.status !== 'open') {
      throw new ConflictError('That stock take has already been committed');
    }
    return stockTake;
  }

  return {
    getItem,
    listItems: (activeOnly: boolean) => repository.listItems(activeOnly),
    listLevels: (activeOnly: boolean): Promise<StockLevel[]> => repository.listLevels(activeOnly),
    searchItems: (term: string) => repository.searchItems(term),
    createItem,
    updateItem,
    recordPurchase,
    openStockTake,
    recordCounts,
    commitStockTake,
    adjust,
    listStockTakes: () => repository.listStockTakes(),
  };
}

export type StockService = ReturnType<typeof createStockService>;
