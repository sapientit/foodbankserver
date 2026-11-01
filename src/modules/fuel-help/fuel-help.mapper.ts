import { parseAnswers } from '../../core/answers.ts';
import type { Referral } from '../../db/schema/referrals.ts';
import type { Session } from '../../db/schema/sessions.ts';

/**
 * The referral form's fixed fields that may appear on the fuel help list, by
 * the `keyField` name the questionnaire gives them.
 *
 * **This is the output allowlist, not the form.** A row carries one of these
 * only when the referral's own release marks that question `forFuelTeam` —
 * see `INITIAL_SPEC1.txt`, `#Fuel help list` — but a flag can only switch on
 * a field named here. A `keyField` this list does not name is ignored, so
 * adding a column to `referrals` or a question to the form never widens the
 * response by itself.
 *
 * Deliberately absent:
 *
 * - **`reasonId`.** The list does not carry the reason for referral. Sending
 *   it would also mean translating the id to its label, which is not done
 *   here; if the charity ever wants it, that is a change to make on purpose,
 *   not by ticking a box on the form.
 * - **`sessionId`.** The row already carries the date of the session the
 *   parcel was issued at, which is not always the referral's own.
 * - **`needsFuelHelp`.** Always sent, flagged or not — see below.
 *
 * Each name is also the `Referral` property it is read from; the `satisfies`
 * holds that true.
 */
const FUEL_TEAM_FIELDS = [
  'referrerName',
  'referrerEmail',
  'referrerOrganisation',
  'referrerPhone',
  'refereeFirstName',
  'refereeSurname',
  'refereeDateOfBirth',
  'refereeAddress',
  'refereePostcode',
  'refereePhone',
] as const satisfies readonly (keyof Referral)[];

type FuelTeamField = (typeof FUEL_TEAM_FIELDS)[number];

/**
 * One household to ring about a fuel bill.
 *
 * Response mappers are the output allowlist, and here **what is absent is the
 * point** — as it is on the listener sheet, which this is the counterpart of.
 *
 * **The fixed fields are the ones the form marks for the fuel team.** Each of
 * the optional fields below is present only when the release the referral was
 * filled in under flags that question `forFuelTeam`, and absent otherwise —
 * absent, not null, because null already means "the referral gave none". A
 * referral with no release, or whose release cannot be read, carries none of
 * them. See `FUEL_TEAM_FIELDS` for what a flag can and cannot switch on.
 *
 * **No reason for referral**, whatever the form says. A fuel administrator is
 * being told that a household needs help with a fuel bill, which is all they
 * need in order to help with it, and the listener sheet stays the only place
 * outside the administrators where the reason appears.
 *
 * **No household counts, and not whether the parcel was delivered.** Neither
 * bears on a fuel bill.
 *
 * `needsFuelHelp` **is** always here, and it is always `true` — every row on
 * this list passed the repository's own filter on it. It is still a real
 * column read off the referral rather than a literal, because the client form
 * shows this question as a fixed field everywhere else it appears and this row
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
  readonly referrerName?: string | null;
  readonly referrerEmail?: string | null;
  readonly referrerOrganisation?: string | null;
  readonly referrerPhone?: string | null;
  readonly refereeFirstName?: string | null;
  readonly refereeSurname?: string | null;
  /** `YYYY-MM-DD`. A date, not an age — an age is wrong a year later. */
  readonly refereeDateOfBirth?: string | null;
  readonly refereeAddress?: string | null;
  readonly refereePostcode?: string | null;
  readonly refereePhone?: string | null;
  readonly needsFuelHelp: boolean;
  readonly answers: Record<string, unknown>;
  /**
   * The release of the referral form these answers were given to; render them
   * with that release's questions (`GET /configuration-releases/bulk`). Null
   * never in practice — migration `0040` backfilled every referral — but the
   * column is nullable, so the contract says so.
   */
  readonly formId: string | null;
}

/**
 * `fuelTeamKeyFields` is every `keyField` the referral's release flags
 * `forFuelTeam`, unfiltered — this function is where the allowlist applies.
 */
export function toFuelHelpHousehold(
  referral: Referral,
  session: Session,
  fuelTeamKeyFields: ReadonlySet<string>,
): FuelHelpHousehold {
  const fixed: Partial<Record<FuelTeamField, string | null>> = {};
  for (const field of FUEL_TEAM_FIELDS) {
    if (fuelTeamKeyFields.has(field)) fixed[field] = referral[field];
  }

  return {
    referralId: referral.id,
    sessionDate: session.sessionDate,
    ...fixed,
    needsFuelHelp: referral.needsFuelHelp === 1,
    answers: parseAnswers(referral.answersJson),
    formId: referral.formId,
  };
}
