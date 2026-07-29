import { z } from 'zod';
import { FORM_FIELD_TYPES } from '../../db/schema/forms.ts';

export const formDraftSchema = z.object({
  title: z.string().min(1).max(200),
});

const optionsSchema = z.array(z.string().min(1).max(200)).max(100);

export const formFieldInputSchema = z
  .object({
    /** The key answers are stored under. Never reused for a different question. */
    key: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z][a-z0-9_]*$/, 'must be lowercase letters, digits and underscores'),
    label: z.string().min(1).max(300),
    helpText: z.string().max(500).nullable().default(null),
    type: z.enum(FORM_FIELD_TYPES),
    isRequired: z.boolean().default(false),
    options: optionsSchema.default([]),
    minValue: z.number().int().nullable().default(null),
    maxValue: z.number().int().nullable().default(null),
    maxLength: z.number().int().min(1).max(10000).nullable().default(null),
    /**
     * Defaults to true. A question is treated as personal data unless someone
     * deliberately says otherwise — the safe direction to be wrong in, since
     * this drives what a purge strips.
     */
    isPii: z.boolean().default(true),
    displayOrder: z.number().int().min(0).max(1000).default(0),
  })
  .refine(
    (value) => !['select', 'multiselect'].includes(value.type) || value.options.length > 0,
    'a select field must offer at least one option',
  );

export const formFieldPatchSchema = z
  .object({
    label: z.string().min(1).max(300),
    helpText: z.string().max(500).nullable(),
    isRequired: z.boolean(),
    options: optionsSchema,
    minValue: z.number().int().nullable(),
    maxValue: z.number().int().nullable(),
    maxLength: z.number().int().min(1).max(10000).nullable(),
    isPii: z.boolean(),
    displayOrder: z.number().int().min(0).max(1000),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

export type FormFieldInput = z.infer<typeof formFieldInputSchema>;
