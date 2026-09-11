import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { referralImports, type NewReferralImport } from '../../db/schema/dev-test-imports.ts';
import { expectAtMostOne } from '../../db/expect.ts';

export function createDevTestImportsRepository(db: Database) {
  return {
    async findByImportKey(importKey: string) {
      const rows = await db
        .select()
        .from(referralImports)
        .where(eq(referralImports.importKey, importKey));
      return expectAtMostOne(rows);
    },

    // ---- Statement builder. Compose with the referral inserts it rides
    // alongside, then run ONE db.batch() — see `dev-test-imports.service.ts`.

    buildInsertImportRecord(value: NewReferralImport) {
      return db.insert(referralImports).values(value);
    },
  };
}

export type DevTestImportsRepository = ReturnType<typeof createDevTestImportsRepository>;
