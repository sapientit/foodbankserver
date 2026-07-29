import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import type { Database } from '../../db/client.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import type { FormDefinition, FormField, NewFormField } from '../../db/schema/forms.ts';
import type { Patch } from '../../core/types.ts';
import type { FormsRepository } from './forms.repository.ts';
import type { FieldSpec } from './answers.ts';

export interface FormWithFields {
  readonly definition: FormDefinition;
  readonly fields: FormField[];
}

export interface FormsServiceDeps {
  readonly db: Database;
  readonly repository: FormsRepository;
  readonly clock: Clock;
}

export function createFormsService({ db, repository, clock }: FormsServiceDeps) {
  async function getDefinition(id: string): Promise<FormDefinition> {
    const definition = await repository.findDefinitionById(id);
    if (definition === undefined) {
      throw new NotFoundError('Form definition not found');
    }
    return definition;
  }

  /**
   * Only drafts may be changed.
   *
   * Once published, a version is the historical record of how a referral was
   * captured. Editing it would silently change the meaning of answers already
   * stored against it.
   */
  async function requireDraft(id: string): Promise<FormDefinition> {
    const definition = await getDefinition(id);
    if (definition.status !== 'draft') {
      throw new ConflictError('Only a draft form can be changed. Create a new version instead.');
    }
    return definition;
  }

  async function createDraft(title: string): Promise<FormDefinition> {
    const now = clock.nowIso();
    return repository.insertDefinition({
      id: crypto.randomUUID(),
      version: await repository.nextVersion(),
      title,
      status: 'draft',
      publishedAt: null,
      retiredAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function withFields(definition: FormDefinition): Promise<FormWithFields> {
    return { definition, fields: await repository.listFields(definition.id) };
  }

  async function getPublished(): Promise<FormWithFields> {
    const definition = await repository.findPublished();
    if (definition === undefined) {
      throw new NotFoundError('No referral form has been published yet');
    }
    return withFields(definition);
  }

  /**
   * Publishes a draft, retiring whatever was published before.
   *
   * Both writes go in one `db.batch()`. There is no transaction on D1, and a
   * half-applied publish would either leave two published versions — which the
   * partial unique index would then reject — or none, which takes the public
   * referral form offline.
   */
  async function publish(id: string): Promise<FormDefinition> {
    const draft = await requireDraft(id);

    const fields = await repository.listFields(id);
    if (fields.length === 0) {
      throw new ConflictError('A form with no questions cannot be published');
    }

    const now = clock.nowIso();
    const current = await repository.findPublished();

    // Retire first: the partial unique index allows only one published row, so
    // the order within the batch matters.
    await db.batch(
      current === undefined
        ? [repository.buildPublishDefinition(id, now)]
        : [
            repository.buildRetireDefinition(current.id, now),
            repository.buildPublishDefinition(id, now),
          ],
    );

    return { ...draft, status: 'published', publishedAt: now, updatedAt: now };
  }

  async function addField(
    formDefinitionId: string,
    input: Omit<NewFormField, 'id' | 'formDefinitionId' | 'createdAt' | 'updatedAt'>,
  ): Promise<FormField> {
    await requireDraft(formDefinitionId);
    const now = clock.nowIso();

    try {
      return await repository.insertField({
        ...input,
        id: crypto.randomUUID(),
        formDefinitionId,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      // Reusing a key would silently change the meaning of answers already
      // stored under it. The unique index is the guard; this turns it into an
      // answer the admin can act on rather than an opaque 500.
      if (isUniqueViolation(error, 'form_fields.form_definition_id', 'form_fields.key')) {
        throw new ConflictError('A question with that key already exists on this form', {
          cause: error,
          details: { key: input.key },
        });
      }
      throw error;
    }
  }

  async function updateField(fieldId: string, patch: Patch<NewFormField>): Promise<FormField> {
    const field = await repository.findFieldById(fieldId);
    if (field === undefined) {
      throw new NotFoundError('Form field not found');
    }
    await requireDraft(field.formDefinitionId);

    const updated = await repository.updateField(fieldId, { ...patch, updatedAt: clock.nowIso() });
    if (updated === undefined) {
      throw new NotFoundError('Form field not found');
    }
    return updated;
  }

  async function deleteField(fieldId: string): Promise<void> {
    const field = await repository.findFieldById(fieldId);
    if (field === undefined) return; // Idempotent.

    await requireDraft(field.formDefinitionId);
    await repository.deleteField(fieldId);
  }

  return {
    listDefinitions: () => repository.listDefinitions(),
    getDefinition,
    getDefinitionWithFields: async (id: string) => withFields(await getDefinition(id)),
    getPublished,
    createDraft,
    publish,
    addField,
    updateField,
    deleteField,
  };
}

export type FormsService = ReturnType<typeof createFormsService>;

/** Turns stored fields into the shape the pure validator expects. */
export function toFieldSpecs(fields: readonly FormField[]): FieldSpec[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    isRequired: field.isRequired === 1,
    options: parseOptions(field.optionsJson),
    minValue: field.minValue,
    maxValue: field.maxValue,
    maxLength: field.maxLength,
    isPii: field.isPii === 1,
  }));
}

function parseOptions(optionsJson: string | null): string[] {
  if (optionsJson === null) return [];
  try {
    const parsed: unknown = JSON.parse(optionsJson);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}
