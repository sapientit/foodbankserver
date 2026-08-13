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
 * **`adminInfo` is admin-only and narrower still** — it is only emitted when a
 * caller asks for it, which is what keeps it off the referral list. See
 * `ReferralResponseOptions`.
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
  /**
   * The administrators' own note about this household — free text, written by
   * the office rather than by the referrer.
   *
   * **Admin-only, and only on a response carrying one referral.** It is absent
   * rather than null for a team lead, and absent from the list for everybody:
   * see `ReferralResponseOptions.includeAdminInfo`.
   */
  readonly adminInfo?: string | null | undefined;
  /**
   * How many times this household has been referred in the last twelve
   * months, and the session date of the most recent of those. Admin-only,
   * like the four fields above, and only present when the caller supplies
   * it — `GET /referrals/:id` fetches it for an administrator only, so a
   * team lead's request costs no extra query.
   */
  readonly repeatReferrals?: RepeatReferralSummaryResponse | undefined;
}

/**
 * What a caller has to ask for on top of the fields every referral response
 * carries. Both are admin-only whatever is passed here — this decides whether
 * the field is offered at all, and `actor.role` decides whether it is given.
 */
export interface ReferralResponseOptions {
  /**
   * The repeat-referral count, when the caller has paid for the query.
   * `GET /referrals/:id` fetches it for an administrator; nothing else does.
   */
  readonly repeatReferrals?: RepeatReferralSummaryResponse | undefined;
  /**
   * Emit `adminInfo`.
   *
   * **Opt-in, so that the referral list cannot acquire it by accident.** The
   * charity asked for the note on the referral an administrator has open, not
   * on every row of a list they are scanning — and a list is the response most
   * likely to be widened later by somebody adding a column. Defaulting this on
   * would put a note about every household on a screen nobody asked to see it
   * on. `INITIAL_SPEC1.txt`, "Referral maintenance".
   */
  readonly includeAdminInfo?: boolean | undefined;
}

export function toReferralResponse(
  referral: Referral,
  actor: Actor,
  options: ReferralResponseOptions = {},
): ReferralResponse {
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

  const { repeatReferrals, includeAdminInfo } = options;

  return {
    ...base,
    reasonId: referral.reasonId,
    referrerEmail: referral.referrerEmail,
    referrerPhone: referral.referrerPhone,
    reviewComment: referral.reviewComment,
    // Spread rather than assigned, so an unasked-for field is absent rather
    // than null — a client cannot tell "you may not see this" from "there is
    // no note" if both arrive as null.
    ...(includeAdminInfo === true ? { adminInfo: referral.adminInfo } : {}),
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

/**
 * One `POST /referrals/search` result — `INITIAL_SPEC1.txt`,
 * `#Searching for a referral`: the administrator's working row, so that the
 * person on the phone can be answered without opening anything.
 *
 * **The postcode and the phone number are returned; the date of birth and the
 * address are not.** That is not an inconsistency. The first two are what the
 * caller is reading out to identify themselves and what the administrator has
 * to read back to be sure they have the right household. The address is the
 * one that turns a postcode search in a hostel or a refuge into a screen of
 * other people's front doors, and the date of birth is never needed to
 * recognise a row — it is only ever an input here.
 *
 * **`answers` is handed over whole, exactly as the listener sheet and a parcel
 * hand it over.** The secondary cause of crisis and the additional crisis
 * detail the administrator needs on this screen live in there, under keys the
 * referral form owns. The server holds no form definition, so it does not know
 * which keys those are and **must not guess** — extracting two of them by name
 * here would put the server in the business of knowing the form, which is the
 * one thing this design has consistently refused. The whole blob belongs to the
 * client; the client reads what it needs out of it.
 *
 * **Still no review comment, referrer email or referrer phone**, and no date of
 * birth or address. `reasonId` is resolved by the client against the admin
 * referral-reasons lookup.
 */
export interface ReferralSearchResult {
  readonly referralId: string;
  /** `YYYY-MM-DD`, London — the referral's own session. */
  readonly sessionDate: string;
  readonly status: string;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly reasonId: string;
  readonly referrerName: string | null;
  readonly answers: Record<string, unknown>;
}

/**
 * The mapper's own input shape, deliberately declared here rather than
 * imported from the service — the same pattern as `RepeatReferralMatchInput`
 * above. It is what stops a column added to the repository's candidate row
 * from reaching a client just because somebody selected it.
 */
interface ReferralSearchMatchInput {
  readonly id: string;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly sessionDate: string;
  readonly status: string;
  readonly reasonId: string;
  readonly referrerName: string | null;
  readonly answersJson: string | null;
}

export function toReferralSearchResult(match: ReferralSearchMatchInput): ReferralSearchResult {
  return {
    referralId: match.id,
    sessionDate: match.sessionDate,
    status: match.status,
    refereeFirstName: match.refereeFirstName,
    refereeSurname: match.refereeSurname,
    refereePostcode: match.refereePostcode,
    refereePhone: match.refereePhone,
    reasonId: match.reasonId,
    referrerName: match.referrerName,
    answers: parseAnswers(match.answersJson),
  };
}

/** The `POST /referrals/search` body in full. */
export interface ReferralSearchResponse {
  readonly count: number;
  readonly results: readonly ReferralSearchResult[];
}

export function toReferralSearchResponse(result: {
  readonly count: number;
  readonly results: readonly ReferralSearchMatchInput[];
}): ReferralSearchResponse {
  return {
    count: result.count,
    results: result.results.map(toReferralSearchResult),
  };
}

/**
 * One household on `GET /sessions/{sessionId}/referral-details` —
 * `INITIAL_SPEC1.txt`, `#Reviewing a referral`, the team-leader paragraph:
 * "the client name, address, postcode and phone number, and the referrer's
 * name and phone number. It does not carry the reason for referral, date of
 * birth, answers, review comment or parcel contents."
 *
 * This is a wider read than the listener sheet — it hands a team leader a
 * household's address and phone number, which the listener sheet deliberately
 * withholds — and it is deliberately narrower than `ReferralResponse`: no
 * reason, no date of birth, no answers, no review comment, no referrer email
 * or organisation. It exists so the team can ring a household, not so they
 * can read the referral.
 */
export interface ReferralDetailsHousehold {
  readonly referralId: string;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly referrerName: string | null;
  readonly referrerPhone: string | null;
}

export function toReferralDetailsHousehold(referral: Referral): ReferralDetailsHousehold {
  return {
    referralId: referral.id,
    refereeFirstName: referral.refereeFirstName,
    refereeSurname: referral.refereeSurname,
    refereeAddress: referral.refereeAddress,
    refereePostcode: referral.refereePostcode,
    refereePhone: referral.refereePhone,
    referrerName: referral.referrerName,
    referrerPhone: referral.referrerPhone,
  };
}

/** The `GET /sessions/{sessionId}/referral-details` body in full. */
export interface ReferralDetailsResponse {
  readonly sessionId: string;
  readonly sessionDate: string;
  readonly startTime: string;
  readonly location: string;
  readonly referrals: readonly ReferralDetailsHousehold[];
}

export function toReferralDetailsResponse(
  session: {
    readonly id: string;
    readonly sessionDate: string;
    readonly startTime: string;
    readonly location: string;
  },
  referrals: readonly Referral[],
): ReferralDetailsResponse {
  return {
    sessionId: session.id,
    sessionDate: session.sessionDate,
    startTime: session.startTime,
    location: session.location,
    referrals: referrals.map(toReferralDetailsHousehold),
  };
}
