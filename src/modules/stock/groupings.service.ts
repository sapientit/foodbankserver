import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import type { StockTakeGrouping } from '../../db/schema/crates.ts';
import type { GroupingsRepository } from './groupings.repository.ts';

export interface GroupingsServiceDeps {
  readonly repository: GroupingsRepository;
  readonly clock: Clock;
}

export function createGroupingsService({ repository, clock }: GroupingsServiceDeps) {
  async function listGroupings(): Promise<StockTakeGrouping[]> {
    return repository.listGroupings();
  }

  async function createGrouping(name: string): Promise<StockTakeGrouping> {
    const now = clock.nowIso();
    try {
      return await repository.insertGrouping({
        id: crypto.randomUUID(),
        name,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'stock_take_groupings.name')) {
        throw new ConflictError('A grouping with that name already exists', { cause: error });
      }
      throw error;
    }
  }

  async function updateGrouping(id: string, name: string): Promise<StockTakeGrouping> {
    try {
      const updated = await repository.updateGrouping(id, { name, updatedAt: clock.nowIso() });
      if (updated === undefined) {
        throw new NotFoundError('Stock-take grouping not found');
      }
      return updated;
    } catch (error) {
      if (isUniqueViolation(error, 'stock_take_groupings.name')) {
        throw new ConflictError('A grouping with that name already exists', { cause: error });
      }
      throw error;
    }
  }

  return { listGroupings, createGrouping, updateGrouping };
}

export type GroupingsService = ReturnType<typeof createGroupingsService>;
