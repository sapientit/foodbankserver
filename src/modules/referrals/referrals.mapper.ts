import type { Actor } from '../../core/actor.ts';
import type { Referral } from '../../db/schema/referrals.ts';

/**
 * Response mappers are the output allowlist — and for referrals they are also
 * the access-control boundary.
 *
 * **`reasonId` is admin-only.** It is the closest thing in this system to
 * special-category data: financial hardship, domestic abuse, immigration
 * status. A team lead runs the session and needs household size and delivery
 * flag; they do not need to know why someone is hungry.
 *
 * That rule is enforced here rather than by hoping each query forgets to
 * select the column, because adding a column to a table must never widen an
 * API response by accident.
 */

export interface ReferralResponse {
  readonly id: string;
  readonly sessionId: string;
  readonly status: string;
  readonly referredAt: string;
  readonly adults: number;
  readonly children: number;
  readonly householdSize: number;
  readonly isDelivery: boolean;
  readonly referrerOrganisation: string;
  readonly refereeName: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly deliveryAddress: string | null;
  readonly answers: Record<string, unknown>;
  readonly piiPurgedAt: string | null;
  /** Present only for an admin. */
  readonly reasonId?: string | undefined;
  readonly referrerEmail?: string | null | undefined;
  readonly referrerPhone?: string | null | undefined;
}

export function toReferralResponse(referral: Referral, actor: Actor): ReferralResponse {
  const base: ReferralResponse = {
    id: referral.id,
    sessionId: referral.sessionId,
    status: referral.status,
    referredAt: referral.referredAt,
    adults: referral.adults,
    children: referral.children,
    householdSize: referral.adults + referral.children,
    isDelivery: referral.isDelivery === 1,
    referrerOrganisation: referral.referrerOrganisation,
    refereeName: referral.refereeName,
    refereeAddress: referral.refereeAddress,
    refereePostcode: referral.refereePostcode,
    refereePhone: referral.refereePhone,
    deliveryAddress: referral.deliveryAddress,
    answers: parseAnswers(referral.answersJson),
    piiPurgedAt: referral.piiPurgedAt,
  };

  if (actor.role !== 'admin') return base;

  return {
    ...base,
    reasonId: referral.reasonId,
    referrerEmail: referral.referrerEmail,
    referrerPhone: referral.referrerPhone,
  };
}

/**
 * What the referrer sees back after submitting.
 *
 * No `reasonId` here either — the referrer chose it, so echoing it adds
 * nothing, and this response is the one most likely to be screenshotted or
 * forwarded.
 */
export interface ReferralReceiptResponse {
  readonly id: string;
  readonly sessionId: string;
  readonly status: string;
  readonly adults: number;
  readonly children: number;
  readonly isDelivery: boolean;
  readonly editKey: string;
  readonly editKeyExpiresAt: number;
}

export function toReceiptResponse(
  referral: Referral,
  editKey: string,
  editKeyExpiresAt: number,
): ReferralReceiptResponse {
  return {
    id: referral.id,
    sessionId: referral.sessionId,
    status: referral.status,
    adults: referral.adults,
    children: referral.children,
    isDelivery: referral.isDelivery === 1,
    editKey,
    editKeyExpiresAt,
  };
}

/** The referrer's own view during the edit window. Never includes the key. */
export interface SelfServiceReferralResponse {
  readonly id: string;
  readonly sessionId: string;
  readonly status: string;
  readonly adults: number;
  readonly children: number;
  readonly isDelivery: boolean;
  readonly refereeName: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly deliveryAddress: string | null;
  readonly answers: Record<string, unknown>;
}

export function toSelfServiceResponse(referral: Referral): SelfServiceReferralResponse {
  return {
    id: referral.id,
    sessionId: referral.sessionId,
    status: referral.status,
    adults: referral.adults,
    children: referral.children,
    isDelivery: referral.isDelivery === 1,
    refereeName: referral.refereeName,
    refereeAddress: referral.refereeAddress,
    refereePostcode: referral.refereePostcode,
    refereePhone: referral.refereePhone,
    deliveryAddress: referral.deliveryAddress,
    answers: parseAnswers(referral.answersJson),
  };
}

function parseAnswers(answersJson: string | null): Record<string, unknown> {
  if (answersJson === null) return {};
  try {
    const parsed: unknown = JSON.parse(answersJson);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
