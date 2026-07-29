import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  formDefinitions,
  formFields,
  type FormDefinition,
  type FormField,
  type NewFormDefinition,
  type NewFormField,
} from '../../db/schema/forms.ts';
import type { Patch } from '../../core/types.ts';

export function createFormsRepository(db: Database) {
  return {
    async listDefinitions(): Promise<FormDefinition[]> {
      return db.select().from(formDefinitions).orderBy(desc(formDefinitions.version));
    },

    async findDefinitionById(id: string): Promise<FormDefinition | undefined> {
      const rows = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.id, id))
        .limit(1);
      return expectAtMostOne(rows);
    },

    async findPublished(): Promise<FormDefinition | undefined> {
      const rows = await db
        .select()
        .from(formDefinitions)
        .where(eq(formDefinitions.status, 'published'))
        .limit(1);
      return expectAtMostOne(rows);
    },

    /** The next version number. Versions are never reused. */
    async nextVersion(): Promise<number> {
      const rows = await db
        .select({ highest: sql<number | null>`MAX(${formDefinitions.version})` })
        .from(formDefinitions);
      return (rows[0]?.highest ?? 0) + 1;
    },

    async insertDefinition(value: NewFormDefinition): Promise<FormDefinition> {
      const rows = await db.insert(formDefinitions).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert form definition');
      return inserted;
    },

    async updateDefinition(
      id: string,
      patch: Patch<NewFormDefinition>,
    ): Promise<FormDefinition | undefined> {
      const rows = await db
        .update(formDefinitions)
        .set(patch)
        .where(eq(formDefinitions.id, id))
        .returning();
      return expectAtMostOne(rows);
    },

    async listFields(formDefinitionId: string): Promise<FormField[]> {
      return db
        .select()
        .from(formFields)
        .where(eq(formFields.formDefinitionId, formDefinitionId))
        .orderBy(asc(formFields.displayOrder), asc(formFields.key));
    },

    async findFieldById(id: string): Promise<FormField | undefined> {
      const rows = await db.select().from(formFields).where(eq(formFields.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    async insertField(value: NewFormField): Promise<FormField> {
      const rows = await db.insert(formFields).values(value).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert form field');
      return inserted;
    },

    async updateField(id: string, patch: Patch<NewFormField>): Promise<FormField | undefined> {
      const rows = await db.update(formFields).set(patch).where(eq(formFields.id, id)).returning();
      return expectAtMostOne(rows);
    },

    async deleteField(id: string): Promise<void> {
      await db.delete(formFields).where(eq(formFields.id, id));
    },

    // ---- Statement builders. Compose these, then run ONE db.batch(). ----

    buildRetireDefinition(id: string, at: string) {
      return db
        .update(formDefinitions)
        .set({ status: 'retired', retiredAt: at, updatedAt: at })
        .where(eq(formDefinitions.id, id));
    },

    buildPublishDefinition(id: string, at: string) {
      return db
        .update(formDefinitions)
        .set({ status: 'published', publishedAt: at, updatedAt: at })
        .where(eq(formDefinitions.id, id));
    },
  };
}

export type FormsRepository = ReturnType<typeof createFormsRepository>;
