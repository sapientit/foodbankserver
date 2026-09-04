import type { Clock } from '../../core/clock.ts';
import type { VoucherConfigRow } from '../../db/schema/voucher-config.ts';
import type { VoucherConfigInput } from './voucher-config.schema.ts';
import type { VoucherConfigRepository } from './voucher-config.repository.ts';

export interface VoucherConfigServiceDeps {
  readonly repository: VoucherConfigRepository;
  readonly clock: Clock;
}

/**
 * The one Christmas-voucher date range — `INITIAL_SPEC1.txt`, `#Christmas
 * voucher and first-time selection`. Administrator-maintained Master Data,
 * read back by `pick-lists.service.ts` at print time to work out the
 * per-parcel voucher instruction; see `derivations.ts`.
 */
export function createVoucherConfigService({ repository, clock }: VoucherConfigServiceDeps) {
  async function getConfig(): Promise<VoucherConfigRow | undefined> {
    return repository.find();
  }

  async function saveConfig(input: VoucherConfigInput): Promise<VoucherConfigRow> {
    await repository.save(input.startDate, input.endDate, clock.nowIso());
    const saved = await repository.find();
    if (saved === undefined) throw new Error('Failed to save the voucher date range');
    return saved;
  }

  return { getConfig, saveConfig };
}

export type VoucherConfigService = ReturnType<typeof createVoucherConfigService>;
