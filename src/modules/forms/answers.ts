import type { FormFieldType } from '../../db/schema/forms.ts';

/**
 * Validating dynamic referral answers against a form version.
 *
 * Pure, and deliberately hand-rolled rather than built into a Zod schema: the
 * shape is only known at runtime, from data an admin edited, and it changes
 * whenever the form does.
 *
 * **Failures name the field and the rule, never the answer.** Dynamic answers
 * can hold anything a coordinator chose to ask for, including health or
 * immigration detail, and validation errors travel into logs and responses.
 */

export interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly type: FormFieldType;
  readonly isRequired: boolean;
  readonly options: readonly string[];
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly maxLength: number | null;
  readonly isPii: boolean;
}

export interface AnswerIssue {
  readonly key: string;
  readonly message: string;
}

export type AnswerValue = string | number | boolean | string[];

export interface ValidationResult {
  readonly ok: boolean;
  readonly answers: Record<string, AnswerValue>;
  readonly issues: readonly AnswerIssue[];
}

const DEFAULT_MAX_TEXT = 2000;

export function validateAnswers(
  fields: readonly FieldSpec[],
  submitted: Record<string, unknown>,
): ValidationResult {
  const issues: AnswerIssue[] = [];
  const answers: Record<string, AnswerValue> = {};

  for (const field of fields) {
    const raw = submitted[field.key];

    if (isBlank(raw)) {
      if (field.isRequired) {
        issues.push({ key: field.key, message: 'is required' });
      }
      continue;
    }

    const checked = coerce(field, raw);
    if ('message' in checked) {
      issues.push({ key: field.key, message: checked.message });
      continue;
    }
    answers[field.key] = checked.value;
  }

  // Unknown keys are dropped rather than rejected. A referral submitted a
  // moment after an admin removed a question should still land — the answer
  // simply has nowhere to go.
  return { ok: issues.length === 0, answers, issues };
}

/** Keys whose answers must be stripped when personal data is purged. */
export function piiAnswerKeys(fields: readonly FieldSpec[]): string[] {
  return fields.filter((field) => field.isPii).map((field) => field.key);
}

/** Removes PII answers in place of a purge, keeping non-PII ones for reporting. */
export function stripPiiAnswers(
  fields: readonly FieldSpec[],
  answers: Record<string, AnswerValue>,
): Record<string, AnswerValue> {
  const piiKeys = new Set(piiAnswerKeys(fields));
  return Object.fromEntries(Object.entries(answers).filter(([key]) => !piiKeys.has(key)));
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

type Coerced = { value: AnswerValue } | { message: string };

function coerce(field: FieldSpec, raw: unknown): Coerced {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'date':
      return coerceText(field, raw);

    case 'number':
      return coerceNumber(field, raw);

    case 'boolean':
      return typeof raw === 'boolean' ? { value: raw } : { message: 'must be true or false' };

    case 'select':
      if (typeof raw !== 'string') return { message: 'must be one of the offered options' };
      return field.options.includes(raw)
        ? { value: raw }
        : { message: 'must be one of the offered options' };

    case 'multiselect': {
      if (!Array.isArray(raw)) return { message: 'must be a list of the offered options' };
      const values = raw.filter((item): item is string => typeof item === 'string');
      if (values.length !== raw.length) {
        return { message: 'must be a list of the offered options' };
      }
      return values.every((item) => field.options.includes(item))
        ? { value: values }
        : { message: 'must be a list of the offered options' };
    }
  }
}

function coerceText(field: FieldSpec, raw: unknown): Coerced {
  if (typeof raw !== 'string') return { message: 'must be text' };

  const value = raw.trim();
  const limit = field.maxLength ?? DEFAULT_MAX_TEXT;
  if (value.length > limit) {
    return { message: `must be ${String(limit)} characters or fewer` };
  }
  return { value };
}

function coerceNumber(field: FieldSpec, raw: unknown): Coerced {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) return { message: 'must be a number' };

  if (field.minValue !== null && value < field.minValue) {
    return { message: `must be ${String(field.minValue)} or more` };
  }
  if (field.maxValue !== null && value > field.maxValue) {
    return { message: `must be ${String(field.maxValue)} or fewer` };
  }
  return { value };
}
