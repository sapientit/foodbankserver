import { parseAnswers } from '../../core/answers.ts';
import type { Referral } from '../../db/schema/referrals.ts';

/**
 * What the browser writes to the spreadsheet, and the only thing that decides
 * what leaves.
 *
 * ## This is an allowlist, and it matters more than a response mapper
 *
 * Response mappers stop a new column on `referrals` from silently widening an
 * API response. This does the same job for the spreadsheet, where the stakes
 * are higher: what goes through here ends up somewhere neither `requireRole`
 * nor the twelve-month purge can reach — see
 * `docs/engineering/personal-data.md`.
 *
 * The row is built field by field from an explicit list. **Never spread a
 * referral into it**, and never add a field because it happens to be
 * available. Adding one changes what the charity holds outside its own
 * system, which is the charity's decision and not a tidying-up.
 *
 * ## Why the personal fields are here at all
 *
 * The charity decided it, knowingly — `INITIAL_SPEC1.txt`, `#Sending
 * referrals to the spreadsheet`. The food bank keeps its records in this
 * spreadsheet and a spreadsheet of households with the households left out
 * would not have been worth keeping. `reviewComment` is the one to think
 * hardest about: inside the system it is admin-only because it can name a
 * referrer or record a suspicion, and on the spreadsheet everyone it is
 * shared with can read it.
 *
 * ## Fixed fields, then dynamic answers
 *
 * The fixed fields below are the fixed columns. `answers` is deliberately an
 * **object rather than a JSON string**: the spreadsheet keeps a hidden
 * metadata sheet mapping each answer key to its column, the browser reads
 * that mapping and puts each key's answer in its own column, adding a column
 * and updating the mapping when it meets a new key. That mapping is
 * spreadsheet state and is **not** stored in D1 — the server does not know or
 * care which column anything lands in.
 */
export interface ExtractRow {
  readonly referralId: string;
  readonly status: string;
  readonly referredAt: string;
  readonly referrerOrganisation: string;
  readonly referrerName: string | null;
  readonly referrerEmail: string | null;
  readonly referrerPhone: string | null;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereeDateOfBirth: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly adults: number;
  readonly children: number;
  readonly isDelivery: boolean;
  readonly needsFuelHelp: boolean;
  /** The label, not the id. A UUID in a spreadsheet helps nobody. */
  readonly reason: string | null;
  readonly reviewComment: string | null;
  /** Answer key to answer. The browser maps keys to columns, not the server. */
  readonly answers: Record<string, unknown>;
}

/**
 * One referral, as one row.
 *
 * The reason arrives as a label resolved by the caller from the reason list
 * loaded once per claim — looking one up per referral would be a query per
 * row. Retired reasons have to resolve too: a referral citing one keeps it,
 * and it still belongs on the row.
 */
export function toExtractRow(referral: Referral, reasonLabel: string | null): ExtractRow {
  return {
    referralId: referral.id,
    status: referral.status,
    referredAt: referral.referredAt,
    referrerOrganisation: referral.referrerOrganisation,
    referrerName: referral.referrerName,
    referrerEmail: referral.referrerEmail,
    referrerPhone: referral.referrerPhone,
    refereeFirstName: referral.refereeFirstName,
    refereeSurname: referral.refereeSurname,
    refereeDateOfBirth: referral.refereeDateOfBirth,
    refereeAddress: referral.refereeAddress,
    refereePostcode: referral.refereePostcode,
    refereePhone: referral.refereePhone,
    adults: referral.adults,
    children: referral.children,
    isDelivery: referral.isDelivery === 1,
    needsFuelHelp: referral.needsFuelHelp === 1,
    reason: reasonLabel,
    reviewComment: referral.reviewComment,
    answers: parseAnswers(referral.answersJson),
  };
}
