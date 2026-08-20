import { parseAnswers } from '../../core/answers.ts';
import type { Referral } from '../../db/schema/referrals.ts';
import type { Session } from '../../db/schema/sessions.ts';

/**
 * One household to ring about a fuel bill.
 *
 * Response mappers are the output allowlist, and here **what is absent is the
 * point** — as it is on the listener sheet, which this is the counterpart of.
 *
 * **No reason for referral.** A fuel administrator is being told that a
 * household needs help with a fuel bill, which is all they need in order to
 * help with it. Why the household was referred is not theirs, and the listener
 * sheet stays the only place outside the administrators where the reason
 * appears.
 *
 * **No household counts, and not whether the parcel was delivered.** Neither
 * bears on a fuel bill.
 *
 * The date of birth **is** here. It was deliberately absent until the charity
 * asked for it — it identifies the household to whoever follows the fuel bill
 * up. Do not take it back out on the strength of an older comment saying the
 * row already holds enough to identify somebody; that was the rule and is not
 * any more.
 *
 * `needsFuelHelp` **is** here too, and it is always `true` — every row on this
 * list passed the repository's own filter on it. It is still a real column
 * read off the referral rather than a literal, because the client form shows
 * this question as a fixed field everywhere else it appears and this row
 * should not be the one place that makes the reader infer it from context.
 *
 * `answers` is handed over **whole**, exactly as the listener sheet does it.
 * The pre-payment-meter and permission-to-ring questions are ordinary
 * questions on a form the client owns, so which keys they are is the client's
 * to know and naming them here would be a guess. The system does not leave
 * anybody off the list on the strength of them either: every household meeting
 * the four conditions is listed, and a person decides whether to ring.
 *
 * The row carries the **session's** date, taken from the session the parcel
 * sat on. See the repository for why that is not always the referral's own
 * session.
 */
export interface FuelHelpHousehold {
  readonly referralId: string;
  /** `YYYY-MM-DD`, London. What the list is ordered by. */
  readonly sessionDate: string;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  /** `YYYY-MM-DD`. A date, not an age — an age is wrong a year later. */
  readonly refereeDateOfBirth: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly needsFuelHelp: boolean;
  readonly answers: Record<string, unknown>;
}

export function toFuelHelpHousehold(referral: Referral, session: Session): FuelHelpHousehold {
  return {
    referralId: referral.id,
    sessionDate: session.sessionDate,
    refereeFirstName: referral.refereeFirstName,
    refereeSurname: referral.refereeSurname,
    refereeDateOfBirth: referral.refereeDateOfBirth,
    refereeAddress: referral.refereeAddress,
    refereePostcode: referral.refereePostcode,
    refereePhone: referral.refereePhone,
    needsFuelHelp: referral.needsFuelHelp === 1,
    answers: parseAnswers(referral.answersJson),
  };
}
