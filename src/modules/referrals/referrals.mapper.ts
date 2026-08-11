import type { Actor } from '../../core/actor.ts';
import { parseAnswers } from '../../core/answers.ts';
import type { Referral } from '../../db/schema/referrals.ts';
import type { MatchKind } from './matching.ts';

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
  readonly infants: number;
  readonly children4To11: number;
  readonly teenagers12To17: number;
  readonly adults18Plus: number;
  readonly adults: number;
  readonly children: number;
  /** `adults + children`. Deliberately excludes `infants` — see `db/schema/referrals.ts`. */
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
  /**
   * How many times this household has been referred in the last twelve
   * months, and the session date of the most recent of those. Admin-only,
   * like the four fields above, and only present when the caller supplies
   * it — `GET /referrals/:id` fetches it for an administrator only, so a
   * team lead's request costs no extra query.
   */
  readonly repeatReferrals?: RepeatReferralSummaryResponse | undefined;
}

export function toReferralResponse(
  referral: Referral,
  actor: Actor,
  repeatReferrals?: RepeatReferralSummaryResponse,
): ReferralResponse {
  const base: ReferralResponse = {
    id: referral.id,
    sessionId: referral.sessionId,
    status: referral.status,
    referredAt: referral.referredAt,
    infants: referral.infants,
    children4To11: referral.children4To11,
    teenagers12To17: referral.teenagers12To17,
    adults18Plus: referral.adults18Plus,
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
    ...(repeatReferrals === undefined ? {} : { repeatReferrals }),
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
  readonly infants: number;
  readonly children4To11: number;
  readonly teenagers12To17: number;
  readonly adults18Plus: number;
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
    infants: referral.infants,
    children4To11: referral.children4To11,
    teenagers12To17: referral.teenagers12To17,
    adults18Plus: referral.adults18Plus,
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

/**
 * One household on the listener sheet, and **nothing else about them**.
 *
 * This is the narrowest mapper in the codebase and the only place a team
 * leader receives the reason for referral. That is a deliberate exception to
 * the rule enforced in `toReferralResponse`, not the rule being relaxed: the
 * listener is having a conversation about what went wrong, and cannot have it
 * without knowing what went wrong.
 *
 * What is absent is the point. No address, no postcode, no phone, no date of
 * birth, nothing about the referrer. A listener needs to know what happened,
 * not where the household lives — and this ends up on paper in a hall.
 *
 * `answers` is handed over **whole**, exactly as `toParcelResponse` does it.
 * The sheet's "Cause Details" is one of those answers, and which one is the
 * client's to know: it owns the form definition and the server holds none.
 * Picking the key out here would be the same guess that four hard-coded
 * dietary keys turned out to be.
 */
export interface ListenerSheetHousehold {
  readonly referralId: string;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  /**
   * The reason's **label**, not its id.
   *
   * It survives a purge — `reasonId` is outside the PII block on purpose, so
   * that reporting still works once nobody is identifiable. Null only if the
   * label could not be found at all, which should not happen and is not worth
   * failing the whole sheet over.
   */
  readonly reason: string | null;
  readonly needsFuelHelp: boolean;
  readonly answers: Record<string, unknown>;
}

export function toListenerSheetHousehold(
  referral: Referral,
  reasonLabel: string | undefined,
): ListenerSheetHousehold {
  return {
    referralId: referral.id,
    refereeFirstName: referral.refereeFirstName,
    refereeSurname: referral.refereeSurname,
    reason: reasonLabel ?? null,
    needsFuelHelp: referral.needsFuelHelp === 1,
    answers: parseAnswers(referral.answersJson),
  };
}

/**
 * `attended` | `no_show` | `booked` — the vocabulary attendance already
 * uses, rather than a second set of words for the same three states.
 */
export type RepeatReferralOutcome = 'attended' | 'no_show' | 'booked';

/** `{ count, mostRecentSessionDate }` — admin-only, embedded in `ReferralResponse`. */
export interface RepeatReferralSummaryResponse {
  readonly count: number;
  /**
   * The most recent match's session date, or `null` when `count` is 0.
   *
   * **May be a date in the future.** It is the session the most recent
   * matching referral is booked for, not a submission date or an
   * attendance date — a household referred twice for next Tuesday reports
   * next Tuesday before either referral has been picked, packed or handed
   * out. Do not assume this is in the past.
   */
  readonly mostRecentSessionDate: string | null;
}

/**
 * Trivial by design. `referrals.repository.ts#countRepeatReferrals` and the
 * service's empty-result short-circuit already return exactly this shape —
 * this function still exists because it is the allowlist boundary a reader
 * checks, not a query that happens to keep it narrow.
 */
export function toRepeatReferralSummary(summary: {
  readonly count: number;
  readonly mostRecentSessionDate: string | null;
}): RepeatReferralSummaryResponse {
  return { count: summary.count, mostRecentSessionDate: summary.mostRecentSessionDate };
}

/**
 * What the "list them in full" button on the review screen shows for one
 * repeat referral — `INITIAL_SPEC1.txt`, `#Reviewing a referral`.
 *
 * **No reason, no answers, no review comment, no normalised columns, no
 * status.** The spec names what the button shows and this is it, plus the
 * session date and outcome. This is more sensitive than `reviewComment`
 * (already admin-only) — it carries another household's name, address,
 * phone number and date of birth — so it is only ever reached through
 * `GET /referrals/{id}/repeat-referrals`, which is admin-only.
 */
export interface RepeatReferralMatchResponse {
  readonly referralId: string;
  readonly sessionId: string;
  /** `YYYY-MM-DD`, London. The referral's **own** session, not a parcel's. */
  readonly sessionDate: string;
  readonly outcome: RepeatReferralOutcome;
  /** Non-empty: which of date of birth, postcode and phone this referral shares. */
  readonly matchedOn: readonly MatchKind[];
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereeDateOfBirth: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
}

/**
 * The mapper's own input shape, deliberately **not** the service's
 * `RepeatReferralMatch` — that type also carries `postcodeNormalised` and
 * `phoneNormalised`, and declaring a narrower shape here is what stops them
 * leaking, rather than trusting every field-by-field copy below to remember
 * to omit them.
 */
interface RepeatReferralMatchInput {
  readonly id: string;
  readonly sessionId: string;
  readonly sessionDate: string;
  readonly outcome: RepeatReferralOutcome;
  readonly matchedOn: readonly MatchKind[];
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereeDateOfBirth: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
}

export function toRepeatReferralMatch(
  match: RepeatReferralMatchInput,
): RepeatReferralMatchResponse {
  return {
    referralId: match.id,
    sessionId: match.sessionId,
    sessionDate: match.sessionDate,
    outcome: match.outcome,
    matchedOn: match.matchedOn,
    refereeFirstName: match.refereeFirstName,
    refereeSurname: match.refereeSurname,
    refereeDateOfBirth: match.refereeDateOfBirth,
    refereeAddress: match.refereeAddress,
    refereePostcode: match.refereePostcode,
    refereePhone: match.refereePhone,
  };
}

/** The `GET /referrals/{id}/repeat-referrals` body in full. */
export interface RepeatReferralListResponse extends RepeatReferralSummaryResponse {
  readonly matches: readonly RepeatReferralMatchResponse[];
}

export function toRepeatReferralListResponse(list: {
  readonly count: number;
  readonly mostRecentSessionDate: string | null;
  readonly matches: readonly RepeatReferralMatchInput[];
}): RepeatReferralListResponse {
  return {
    count: list.count,
    mostRecentSessionDate: list.mostRecentSessionDate,
    matches: list.matches.map(toRepeatReferralMatch),
  };
}
