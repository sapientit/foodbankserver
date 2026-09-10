import type { Actor } from '../../core/actor.ts';
import { parseAnswers } from '../../core/answers.ts';
import type { PlainDate } from '../../core/time/plain-date.ts';
import type { PickList } from '../../db/schema/pick-lists.ts';
import type { Referral } from '../../db/schema/referrals.ts';
import {
  firstTimeMarkerFor,
  voucherInstructionFor,
  type FirstTimeMarker,
  type VoucherDateRange,
  type VoucherInstruction,
} from '../voucher-config/derivations.ts';
import type { ParcelWithLines } from './pick-lists.repository.ts';
import type { StockRequirementLine, StockRequirementSummaryLine } from './stock-requirement.ts';

/** Response mappers are the output allowlist. See CLAUDE.md. */

export interface PickListResponse {
  readonly id: string;
  readonly sessionId: string;
  readonly status: string;
  readonly generatedAt: string;
  readonly firstPrintedAt: string | null;
}

export function toPickListResponse(pickList: PickList): PickListResponse {
  return {
    id: pickList.id,
    sessionId: pickList.sessionId,
    status: pickList.status,
    generatedAt: pickList.generatedAt,
    firstPrintedAt: pickList.firstPrintedAt,
  };
}

export interface ParcelLineResponse {
  readonly stockItemId: string;
  readonly name: string;
  /**
   * The item's description, printed under the name on the sheet — it is what
   * tells a volunteer that half a kilo of pasta counts as one unit. `null` for
   * an item whose name says everything.
   *
   * Not the category: the sheet is walked in shelf order, and the amendment
   * screen gets its grouping from the stock item list rather than from here.
   */
  readonly description: string | null;
  readonly shelfNumber: string;
  /**
   * A positive count, or `-1` for a line a team leader still has to settle.
   *
   * `-1` is not a quantity and must never be rendered as one: the household
   * asked for this item and nobody has yet decided how much of it they get.
   */
  readonly quantity: number;
}

export interface ParcelResponse {
  readonly id: string;
  readonly referralId: string;
  readonly pickNumber: number;
  /** Enough identity to select a household in the session workspace. */
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  /** Chooses collection or delivery attendance language; no address is exposed here. */
  readonly isDelivery: boolean;
  readonly adults: number;
  readonly children: number;
  readonly householdSize: number;
  readonly reviewedAt: string | null;
  readonly attendance: string;
  readonly notes: string | null;
  /**
   * The referral's answers, whole and unfiltered.
   *
   * The pick-list maintenance screen shows the household's preferences beside
   * the parcel, and **which answers are preferences is the client's to know**:
   * it owns the form definition and marks each question `preference: true`.
   * The server holds no definition, so any attempt to pick out the relevant
   * keys here would be a guess — which is exactly what the four hard-coded
   * dietary keys this replaced turned out to be. Empty once the referral has
   * been purged, or if the referral has since been deleted from under the
   * parcel.
   */
  readonly answers: Record<string, unknown>;
  readonly lines: ParcelLineResponse[];
  /**
   * `first_time`, `admin` or no marker at all — never the historic date or
   * anything else about the referral. `INITIAL_SPEC1.txt`, `#Christmas
   * voucher and first-time selection`: this is what tells a team leader on
   * the Run a session screen whether a household is new. Safe for a team
   * lead, unlike the referral's own `firstTimeReview`, which stays
   * admin-only — see `derivations.ts#firstTimeMarkerFor`.
   */
  readonly firstTimeMarker: FirstTimeMarker | null;
  /**
   * The one voucher instruction for this household, shown to the team leader
   * on the Run a session screen. `INITIAL_SPEC1.txt`, `#Christmas voucher and
   * first-time selection`.
   *
   * Calculated fresh on every read, never stored on the parcel and never
   * generated with the pick list: an administrator may make the
   * first-time-review decision after the pick list already exists, and the
   * screen must always show the current one. See
   * `derivations.ts#voucherInstructionFor`.
   *
   * `null` whenever the session's date falls outside the configured voucher
   * range, or no range has been configured. Like the marker above, this
   * carries no historic date and no other referral detail.
   */
  readonly voucherInstruction: VoucherInstruction | null;
}

/** What `toParcelResponse` needs to work out `voucherInstruction`. */
export interface VoucherContext {
  readonly sessionDate: PlainDate;
  readonly voucherRange: VoucherDateRange | undefined;
}

function toParcelLines(lines: ParcelWithLines['lines']): ParcelLineResponse[] {
  return lines.map((line) => ({
    stockItemId: line.stockItemId,
    name: line.item.name,
    description: line.item.description,
    shelfNumber: line.item.shelfNumber,
    quantity: line.quantity,
  }));
}

export function toParcelResponse(
  { parcel, lines }: ParcelWithLines,
  referral: Referral | undefined,
  voucher: VoucherContext,
): ParcelResponse {
  return {
    id: parcel.id,
    referralId: parcel.referralId,
    pickNumber: parcel.pickNumber,
    refereeFirstName: referral?.refereeFirstName ?? null,
    refereeSurname: referral?.refereeSurname ?? null,
    isDelivery: referral?.isDelivery === 1,
    adults: parcel.adults,
    children: parcel.children,
    householdSize: parcel.adults + parcel.children,
    reviewedAt: parcel.reviewedAt,
    attendance: parcel.attendance,
    notes: parcel.notes,
    answers: parseAnswers(referral?.answersJson ?? null),
    firstTimeMarker: firstTimeMarkerFor(referral?.firstTimeReviewStatus),
    voucherInstruction: voucherInstructionFor(voucher.sessionDate, voucher.voucherRange, {
      status: referral?.firstTimeReviewStatus ?? 'unreviewed',
      previousSessionDate: referral?.firstTimeReviewDate ?? null,
    }),
    lines: toParcelLines(lines),
  };
}

/**
 * One printable sheet per parcel.
 *
 * The frontend renders this; the server only decides what belongs on it.
 *
 * - **The pick number and the household's name go on every sheet.** The name
 *   used to be withheld unless the parcel was a delivery. The charity asked for
 *   it on all of them: the person carrying the bag has to hand it to somebody,
 *   and a number alone does not do that. The surname is separate because it is
 *   what a volunteer matches against.
 * - **`DELIVERY`, the address, postcode and phone number appear only when
 *   `isDelivery`.** A delivery goes to the referee's own address — there is no
 *   other one — so these are the referee's own fields, named for what the driver
 *   uses them for. A collection sheet carries none of them.
 * - **No reason for referral**, ever — not even for an admin. A sheet gets
 *   carried round a hall and left on tables. Why someone is hungry is not
 *   picking information.
 * - **Each line carries the item's description**, which is where a unit or a
 *   caveat that does not belong in the name gets to the person packing the bag.
 *   The sheet stays in shelf order; the description does not change what is
 *   printed where, only what each line says.
 * - **No answers.** The preferences belong on the maintenance screen, where
 *   somebody is deciding what goes in the parcel; by print time that decision
 *   is in `lines`.
 * - **No voucher instruction.** The Christmas-voucher decision is acted on at
 *   the session, not off the carried sheet, so it rides on
 *   `ParcelResponse.voucherInstruction` for the Run a session screen and is
 *   deliberately absent here.
 */
export interface PrintParcelResponse {
  readonly pickNumber: number;
  readonly householdSize: number;
  readonly adults: number;
  readonly children: number;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly isDelivery: boolean;
  readonly deliveryAddress: string | null;
  readonly deliveryPostcode: string | null;
  readonly deliveryPhone: string | null;
  readonly notes: string | null;
  readonly lines: ParcelLineResponse[];
}

export function toPrintParcelResponse(
  entry: ParcelWithLines,
  referral: Referral | undefined,
): PrintParcelResponse {
  // Bind the narrowed referral once: the address and phone number are only ever
  // read for a delivery, so there is no path where they reach a collection sheet.
  const delivery = referral?.isDelivery === 1 ? referral : undefined;

  return {
    pickNumber: entry.parcel.pickNumber,
    householdSize: entry.parcel.adults + entry.parcel.children,
    adults: entry.parcel.adults,
    children: entry.parcel.children,
    refereeFirstName: referral?.refereeFirstName ?? null,
    refereeSurname: referral?.refereeSurname ?? null,
    isDelivery: delivery !== undefined,
    deliveryAddress: delivery?.refereeAddress ?? null,
    deliveryPostcode: delivery?.refereePostcode ?? null,
    deliveryPhone: delivery?.refereePhone ?? null,
    notes: entry.parcel.notes,
    lines: toParcelLines(entry.lines),
  };
}

/**
 * One line of the session's stock requirement.
 *
 * Deliberately the same shape as `GET /stock/levels` returns for an item, plus
 * the two numbers this screen exists for, so a client can render both lists
 * through the same row component. No parcel and no household reaches it: what
 * the warehouse needs to know is how much of a thing to find, not who it is
 * for.
 */
export interface StockRequirementResponse {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string | null;
  readonly shelfNumber: string;
  readonly isActive: boolean;
  readonly requiredQuantity: number;
  readonly quantityOnHand: number;
  readonly shortfall: number;
}

export function toStockRequirementResponse(line: StockRequirementLine): StockRequirementResponse {
  return {
    id: line.item.id,
    name: line.item.name,
    category: line.item.category,
    description: line.item.description,
    shelfNumber: line.item.shelfNumber,
    isActive: line.item.isActive === 1,
    requiredQuantity: line.requiredQuantity,
    quantityOnHand: line.quantityOnHand,
    shortfall: line.shortfall,
  };
}

/**
 * One line of the cross-session stock requirement report — the same shape as
 * `StockRequirementResponse` minus `quantityOnHand` and `shortfall`, because
 * this report is a total across many sessions, not a comparison against one
 * session's shelf. See `GET /pick-lists/stock-requirement-summary`.
 */
export interface StockRequirementSummaryResponse {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string | null;
  readonly shelfNumber: string;
  readonly isActive: boolean;
  readonly requiredQuantity: number;
}

export function toStockRequirementSummaryResponse(
  line: StockRequirementSummaryLine,
): StockRequirementSummaryResponse {
  return {
    id: line.item.id,
    name: line.item.name,
    category: line.item.category,
    description: line.item.description,
    shelfNumber: line.item.shelfNumber,
    isActive: line.item.isActive === 1,
    requiredQuantity: line.requiredQuantity,
  };
}

/** An admin sees a little more of the picking screen than a team lead does. */
export function canSeeReferralDetail(actor: Actor): boolean {
  return actor.role === 'admin';
}
