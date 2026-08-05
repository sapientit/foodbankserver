import type { Actor } from '../../core/actor.ts';
import type { PickList } from '../../db/schema/pick-lists.ts';
import type { Referral } from '../../db/schema/referrals.ts';
import type { ParcelWithLines } from './pick-lists.repository.ts';

/** Response mappers are the output allowlist. See CLAUDE.md. */

export interface PickListResponse {
  readonly id: string;
  readonly sessionId: string;
  readonly status: string;
  readonly generatedAt: string;
  readonly firstPrintedAt: string | null;
  readonly confirmedAt: string | null;
}

export function toPickListResponse(pickList: PickList): PickListResponse {
  return {
    id: pickList.id,
    sessionId: pickList.sessionId,
    status: pickList.status,
    generatedAt: pickList.generatedAt,
    firstPrintedAt: pickList.firstPrintedAt,
    confirmedAt: pickList.confirmedAt,
  };
}

export interface ParcelLineResponse {
  readonly stockItemId: string;
  readonly name: string;
  readonly shelfNumber: string;
  readonly quantity: number;
  readonly source: string;
}

export interface ParcelResponse {
  readonly id: string;
  readonly referralId: string;
  readonly pickNumber: number;
  readonly adults: number;
  readonly children: number;
  readonly householdSize: number;
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
}

export function toParcelResponse(
  { parcel, lines }: ParcelWithLines,
  referral: Referral | undefined,
): ParcelResponse {
  return {
    id: parcel.id,
    referralId: parcel.referralId,
    pickNumber: parcel.pickNumber,
    adults: parcel.adults,
    children: parcel.children,
    householdSize: parcel.adults + parcel.children,
    attendance: parcel.attendance,
    notes: parcel.notes,
    answers: parseAnswers(referral?.answersJson ?? null),
    lines: lines.map((line) => ({
      stockItemId: line.stockItemId,
      name: line.item.name,
      shelfNumber: line.item.shelfNumber,
      quantity: line.quantity,
      source: line.source,
    })),
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
 * - **No answers.** The preferences belong on the maintenance screen, where
 *   somebody is deciding what goes in the parcel; by print time that decision
 *   is in `lines`.
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
    lines: toParcelResponse(entry, undefined).lines,
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

/** An admin sees a little more of the picking screen than a team lead does. */
export function canSeeReferralDetail(actor: Actor): boolean {
  return actor.role === 'admin';
}
