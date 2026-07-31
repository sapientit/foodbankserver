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
  readonly lines: ParcelLineResponse[];
}

export function toParcelResponse({ parcel, lines }: ParcelWithLines): ParcelResponse {
  return {
    id: parcel.id,
    referralId: parcel.referralId,
    pickNumber: parcel.pickNumber,
    adults: parcel.adults,
    children: parcel.children,
    householdSize: parcel.adults + parcel.children,
    attendance: parcel.attendance,
    notes: parcel.notes,
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
 * The frontend renders this; the server only decides what belongs on it. Two
 * deliberate omissions and one deliberate inclusion:
 *
 * - **No reason for referral**, ever — not even for an admin. A sheet gets
 *   carried round a hall and left on tables. Why someone is hungry is not
 *   picking information.
 * - **No referee name or address unless it is a delivery**, where the address
 *   is the whole point. A delivery goes to the referee's own address — there is
 *   no other one — so `deliveryAddress` here is `refereeAddress`, named for what
 *   the driver uses it for.
 * - **Dietary needs are included** when the form captured them, because the
 *   picker is the only person who can act on them, and the alternative is a
 *   parcel that cannot be eaten.
 */
export interface PrintParcelResponse {
  readonly pickNumber: number;
  readonly householdSize: number;
  readonly adults: number;
  readonly children: number;
  readonly isDelivery: boolean;
  readonly deliveryName: string | null;
  readonly deliveryAddress: string | null;
  readonly dietaryNotes: string | null;
  readonly notes: string | null;
  readonly lines: ParcelLineResponse[];
}

const DIETARY_KEYS = ['dietary_needs', 'dietary_requirements', 'food_preferences', 'allergies'];

export function toPrintParcelResponse(
  entry: ParcelWithLines,
  referral: Referral | undefined,
): PrintParcelResponse {
  // Bind the narrowed referral once: the name and address are only ever read
  // for a delivery, so there is no path where they leak onto a collection sheet.
  const delivery = referral?.isDelivery === 1 ? referral : undefined;

  return {
    pickNumber: entry.parcel.pickNumber,
    householdSize: entry.parcel.adults + entry.parcel.children,
    adults: entry.parcel.adults,
    children: entry.parcel.children,
    isDelivery: delivery !== undefined,
    // Only a delivery needs a name and address on the sheet.
    deliveryName: delivery?.refereeName ?? null,
    deliveryAddress: delivery?.refereeAddress ?? null,
    dietaryNotes: dietaryNotesOf(referral),
    notes: entry.parcel.notes,
    lines: toParcelResponse(entry).lines,
  };
}

/**
 * Pulls dietary information out of the dynamic answers.
 *
 * The form belongs to the client, so the key is not ours to fix — several
 * plausible names are checked rather than assuming one. Anything found is
 * passed through verbatim; the picker needs the actual words.
 */
function dietaryNotesOf(referral: Referral | undefined): string | null {
  if (referral?.answersJson == null) return null;

  try {
    const parsed: unknown = JSON.parse(referral.answersJson);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const answers = parsed as Record<string, unknown>;
    const found = DIETARY_KEYS.map((key) => answers[key])
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .join('; ');

    return found === '' ? null : found;
  } catch {
    return null;
  }
}

/** An admin sees a little more of the picking screen than a team lead does. */
export function canSeeReferralDetail(actor: Actor): boolean {
  return actor.role === 'admin';
}
