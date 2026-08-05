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
 * **`reviewComment` is admin-only** for the same kind of reason: it is an
 * administrator's note on why a referral was let through or turned away, and it
 * can name a referrer or record a suspicion.
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
  readonly needsFuelHelp: boolean;
  readonly referrerOrganisation: string;
  readonly referrerName: string | null;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereeDateOfBirth: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly answers: Record<string, unknown>;
  readonly piiPurgedAt: string | null;
  /** Present only for an admin. */
  readonly reasonId?: string | undefined;
  readonly referrerEmail?: string | null | undefined;
  readonly referrerPhone?: string | null | undefined;
  readonly reviewComment?: string | null | undefined;
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
    needsFuelHelp: referral.needsFuelHelp === 1,
    referrerOrganisation: referral.referrerOrganisation,
    referrerName: referral.referrerName,
    refereeFirstName: referral.refereeFirstName,
    refereeSurname: referral.refereeSurname,
    refereeDateOfBirth: referral.refereeDateOfBirth,
    refereeAddress: referral.refereeAddress,
    refereePostcode: referral.refereePostcode,
    refereePhone: referral.refereePhone,
    answers: parseAnswers(referral.answersJson),
    piiPurgedAt: referral.piiPurgedAt,
  };

  if (actor.role !== 'admin') return base;

  return {
    ...base,
    reasonId: referral.reasonId,
    referrerEmail: referral.referrerEmail,
    referrerPhone: referral.referrerPhone,
    reviewComment: referral.reviewComment,
  };
}

/**
 * What the referrer sees back after submitting.
 *
 * This is now the whole of the referrer's relationship with the system: there
 * is no edit key and no window, so the receipt is a confirmation to read rather
 * than a handle to come back with. It echoes the fixed fields so the
 * confirmation screen can show what was sent, and `status` so a referrer whose
 * address was not recognised is told their referral is waiting to be looked at
 * rather than being left to assume it is booked.
 *
 * No `reasonId` — the referrer chose it, so echoing it adds nothing, and this
 * response is the one most likely to be screenshotted or forwarded.
 */
export interface ReferralReceiptResponse {
  readonly id: string;
  readonly sessionId: string;
  readonly status: string;
  readonly adults: number;
  readonly children: number;
  readonly isDelivery: boolean;
  readonly needsFuelHelp: boolean;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly referredAt: string;
}

export function toReceiptResponse(referral: Referral): ReferralReceiptResponse {
  return {
    id: referral.id,
    sessionId: referral.sessionId,
    status: referral.status,
    adults: referral.adults,
    children: referral.children,
    isDelivery: referral.isDelivery === 1,
    needsFuelHelp: referral.needsFuelHelp === 1,
    refereeFirstName: referral.refereeFirstName,
    refereeSurname: referral.refereeSurname,
    refereeAddress: referral.refereeAddress,
    refereePostcode: referral.refereePostcode,
    referredAt: referral.referredAt,
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
