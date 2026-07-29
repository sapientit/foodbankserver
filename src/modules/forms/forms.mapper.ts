import type { FormDefinition, FormField } from '../../db/schema/forms.ts';
import type { ReferralReason } from '../../db/schema/referrers.ts';

/** Response mappers are the output allowlist. See CLAUDE.md. */

export interface FormFieldResponse {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly helpText: string | null;
  readonly type: string;
  readonly isRequired: boolean;
  readonly options: string[];
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly maxLength: number | null;
  readonly displayOrder: number;
}

export interface AdminFormFieldResponse extends FormFieldResponse {
  /** Admin-only: the purge classification is an internal concern. */
  readonly isPii: boolean;
}

export interface FormDefinitionResponse {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly status: string;
  readonly publishedAt: string | null;
  readonly retiredAt: string | null;
}

export function toFormDefinitionResponse(definition: FormDefinition): FormDefinitionResponse {
  return {
    id: definition.id,
    version: definition.version,
    title: definition.title,
    status: definition.status,
    publishedAt: definition.publishedAt,
    retiredAt: definition.retiredAt,
  };
}

export function toFormFieldResponse(field: FormField): FormFieldResponse {
  return {
    id: field.id,
    key: field.key,
    label: field.label,
    helpText: field.helpText,
    type: field.type,
    isRequired: field.isRequired === 1,
    options: parseOptions(field.optionsJson),
    minValue: field.minValue,
    maxValue: field.maxValue,
    maxLength: field.maxLength,
    displayOrder: field.displayOrder,
  };
}

export function toAdminFormFieldResponse(field: FormField): AdminFormFieldResponse {
  return { ...toFormFieldResponse(field), isPii: field.isPii === 1 };
}

export interface ReferralReasonResponse {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly displayOrder: number;
}

export function toReferralReasonResponse(reason: ReferralReason): ReferralReasonResponse {
  return {
    id: reason.id,
    code: reason.code,
    label: reason.label,
    displayOrder: reason.displayOrder,
  };
}

export interface AdminReferralReasonResponse extends ReferralReasonResponse {
  readonly isActive: boolean;
}

export function toAdminReferralReasonResponse(reason: ReferralReason): AdminReferralReasonResponse {
  return { ...toReferralReasonResponse(reason), isActive: reason.isActive === 1 };
}

/**
 * The whole public referral form: the questions plus the reason dropdown.
 *
 * One payload so the frontend can render the form in a single request — and so
 * the version it was rendered from is unambiguous when the answers come back.
 */
export interface PublicFormResponse {
  readonly formDefinitionId: string;
  readonly version: number;
  readonly title: string;
  readonly reasons: ReferralReasonResponse[];
  readonly fields: FormFieldResponse[];
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
