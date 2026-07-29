import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const FORM_STATUSES = ['draft', 'published', 'retired'] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

/**
 * Field types. Enumerated generously — `date` and `multiselect` are unused in
 * v1, and SQLite cannot extend a CHECK constraint without a table rebuild.
 */
export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'boolean',
  'select',
  'multiselect',
  'date',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/**
 * A version of the referral form.
 *
 * The referral form is a Google Form today and changes periodically, so its
 * questions cannot live in the database schema — see `form_fields`. What can
 * be versioned is the whole definition, and that is what makes an old referral
 * readable: it records which version captured it, and that version is
 * immutable once published.
 *
 * Exactly one version may be `published` at a time, enforced by a partial
 * unique index rather than by application code, because D1 has no transaction
 * in which to check-then-write.
 */
export const formDefinitions = sqliteTable(
  'form_definitions',
  {
    id: text('id').primaryKey(),
    version: integer('version').notNull().unique(),
    title: text('title').notNull(),
    status: text('status').$type<FormStatus>().notNull().default('draft'),
    publishedAt: text('published_at'),
    retiredAt: text('retired_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_form_definitions_one_published')
      .on(table.status)
      .where(sql`${table.status} = 'published'`),
    check(
      'form_definitions_status_valid',
      sql`${table.status} IN ('draft', 'published', 'retired')`,
    ),
  ],
);

/**
 * One question on the form.
 *
 * `key` is the stable column key an answer is stored under in the referral's
 * JSON. It must never be reused for a different question, or historical
 * answers change meaning.
 *
 * The fixed referral columns (session, referrer, referee name and address,
 * adults, children, reason, delivery) are **not** here — they are real typed
 * columns on `referrals`, because the domain branches on them.
 */
export const formFields = sqliteTable(
  'form_fields',
  {
    id: text('id').primaryKey(),
    formDefinitionId: text('form_definition_id')
      .notNull()
      .references(() => formDefinitions.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    helpText: text('help_text'),
    type: text('type').$type<FormFieldType>().notNull(),
    isRequired: integer('is_required').notNull().default(0),
    /** JSON array of `{ value, label }` for select and multiselect. */
    optionsJson: text('options_json'),
    minValue: integer('min_value'),
    maxValue: integer('max_value'),
    maxLength: integer('max_length'),
    /**
     * Whether answers to this question count as personal data. Drives what a
     * PII purge strips out of the answers JSON, so it must be set honestly.
     */
    isPii: integer('is_pii').notNull().default(1),
    displayOrder: integer('display_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    unique('idx_form_fields_key').on(table.formDefinitionId, table.key),
    index('idx_form_fields_definition').on(table.formDefinitionId, table.displayOrder),
    check(
      'form_fields_type_valid',
      sql`${table.type} IN ('text', 'textarea', 'number', 'boolean', 'select', 'multiselect', 'date')`,
    ),
    check('form_fields_is_required_boolean', sql`${table.isRequired} IN (0, 1)`),
    check('form_fields_is_pii_boolean', sql`${table.isPii} IN (0, 1)`),
  ],
);

export const formDefinitionsRelations = relations(formDefinitions, ({ many }) => ({
  fields: many(formFields),
}));

export const formFieldsRelations = relations(formFields, ({ one }) => ({
  definition: one(formDefinitions, {
    fields: [formFields.formDefinitionId],
    references: [formDefinitions.id],
  }),
}));

export type FormDefinition = typeof formDefinitions.$inferSelect;
export type NewFormDefinition = typeof formDefinitions.$inferInsert;
export type FormField = typeof formFields.$inferSelect;
export type NewFormField = typeof formFields.$inferInsert;
