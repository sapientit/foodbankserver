import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  modelParcels,
  parcelGrid,
  PARCEL_GRID_ID,
  type ModelParcel,
  type NewModelParcel,
  type ParcelGridRow,
} from '../../db/schema/rules.ts';
import type { Patch } from '../../core/types.ts';

export function createRulesRepository(db: Database) {
  return {
    /** Every model parcel. One query — the lookup happens in memory. */
    async listModelParcels(): Promise<ModelParcel[]> {
      return db
        .select()
        .from(modelParcels)
        .orderBy(asc(modelParcels.displayOrder), asc(modelParcels.name));
    },

    async findModelParcelById(id: string): Promise<ModelParcel | undefined> {
      const rows = await db.select().from(modelParcels).where(eq(modelParcels.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    async insertModelParcel(value: NewModelParcel): Promise<ModelParcel> {
      const rows = await db.insert(modelParcels).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert model parcel');
      return inserted;
    },

    async updateModelParcel(
      id: string,
      patch: Patch<NewModelParcel>,
    ): Promise<ModelParcel | undefined> {
      const rows = await db
        .update(modelParcels)
        .set(patch)
        .where(eq(modelParcels.id, id))
        .returning();
      return expectAtMostOne(rows);
    },

    async deleteModelParcel(id: string): Promise<void> {
      await db.delete(modelParcels).where(eq(modelParcels.id, id));
    },

    async findGrid(): Promise<ParcelGridRow | undefined> {
      const rows = await db
        .select()
        .from(parcelGrid)
        .where(eq(parcelGrid.id, PARCEL_GRID_ID))
        .limit(1);
      return expectAtMostOne(rows);
    },

    /** The grid is written whole, so this is an upsert of the single row. */
    async saveGrid(gridJson: string, at: string): Promise<void> {
      await db
        .insert(parcelGrid)
        .values({ id: PARCEL_GRID_ID, gridJson, updatedAt: at })
        .onConflictDoUpdate({
          target: parcelGrid.id,
          set: { gridJson, updatedAt: at },
        });
    },
  };
}

export type RulesRepository = ReturnType<typeof createRulesRepository>;
