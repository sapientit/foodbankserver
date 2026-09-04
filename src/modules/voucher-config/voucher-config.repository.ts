import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  voucherConfig,
  VOUCHER_CONFIG_ID,
  type VoucherConfigRow,
} from '../../db/schema/voucher-config.ts';

export function createVoucherConfigRepository(db: Database) {
  return {
    async find(): Promise<VoucherConfigRow | undefined> {
      const rows = await db
        .select()
        .from(voucherConfig)
        .where(eq(voucherConfig.id, VOUCHER_CONFIG_ID))
        .limit(1);
      return expectAtMostOne(rows);
    },

    /** Saved whole, the same singleton upsert `rules.repository.ts#saveGrid` uses. */
    async save(startDate: string, endDate: string, at: string): Promise<void> {
      await db
        .insert(voucherConfig)
        .values({ id: VOUCHER_CONFIG_ID, startDate, endDate, updatedAt: at })
        .onConflictDoUpdate({
          target: voucherConfig.id,
          set: { startDate, endDate, updatedAt: at },
        });
    },
  };
}

export type VoucherConfigRepository = ReturnType<typeof createVoucherConfigRepository>;
