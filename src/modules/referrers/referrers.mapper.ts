import type { AuthorisedReferrer, ReferralReason } from '../../db/schema/referrers.ts';

/** Response mappers are the output allowlist. See CLAUDE.md. */

export interface AuthorisedReferrerResponse {
  readonly id: string;
  readonly matchType: string;
  readonly matchValue: string;
  readonly organisationName: string;
  readonly isActive: boolean;
  readonly notes: string | null;
}

export function toAuthorisedReferrerResponse(row: AuthorisedReferrer): AuthorisedReferrerResponse {
  return {
    id: row.id,
    matchType: row.matchType,
    matchValue: row.matchValue,
    organisationName: row.organisationName,
    isActive: row.isActive === 1,
    notes: row.notes,
  };
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
