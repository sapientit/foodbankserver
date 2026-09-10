import { comparePlainDates, type PlainDate } from '../../core/time/plain-date.ts';
import type { FirstTimeReviewStatus } from '../../db/schema/referrals.ts';

/**
 * Pure logic for the two derived values `INITIAL_SPEC1.txt`'s "Christmas
 * voucher and first-time selection" section asks for. No I/O — the caller
 * reads the voucher range and the referral's first-time-review value once
 * and hands them in.
 */

export interface VoucherDateRange {
  readonly startDate: PlainDate;
  readonly endDate: PlainDate;
}

/** Inclusive at both ends — a session dated on either boundary is in range. */
export function isWithinVoucherRange(date: PlainDate, range: VoucherDateRange): boolean {
  return (
    comparePlainDates(date, range.startDate) >= 0 && comparePlainDates(date, range.endDate) <= 0
  );
}

export type VoucherInstruction = 'provide_voucher' | 'already_received' | 'refer_to_admin';

/**
 * What the top of a printed sheet says, for a session on `sessionDate`.
 *
 * `null` means no instruction belongs on the sheet at all — outside the
 * configured range, or nothing has been configured. Otherwise exactly one of
 * the three instructions the spec names, decided by the recorded
 * first-time-review value: `unreviewed` always defers to an administrator,
 * `no_previous_referral` always says to provide one, and a recorded date says
 * "already received" only when that date itself falls in the range —
 * otherwise it is treated the same as no previous referral.
 */
export function voucherInstructionFor(
  sessionDate: PlainDate,
  range: VoucherDateRange | undefined,
  review: {
    readonly status: FirstTimeReviewStatus;
    readonly previousSessionDate: PlainDate | null;
  },
): VoucherInstruction | null {
  if (range === undefined || !isWithinVoucherRange(sessionDate, range)) return null;

  if (review.status === 'unreviewed') return 'refer_to_admin';
  if (review.status === 'no_previous_referral') return 'provide_voucher';

  return review.previousSessionDate !== null &&
    isWithinVoucherRange(review.previousSessionDate, range)
    ? 'already_received'
    : 'provide_voucher';
}

export type FirstTimeMarker = 'first_time' | 'admin';

/**
 * What a team leader sees on the Run a session screen — never the historic
 * date, never the raw status. `no_previous_referral` reads `first_time`,
 * `unreviewed` (or a referral this couldn't be determined for at all) reads
 * `admin`, and a recorded previous-session date carries no marker at all.
 *
 * The listener sheet (`ListenerSheetHousehold`) shows the same marker: the
 * listener is the person actually talking to the household, so they see
 * whether it is new, just as the team leader does.
 */
export function firstTimeMarkerFor(
  status: FirstTimeReviewStatus | undefined,
): FirstTimeMarker | null {
  if (status === 'no_previous_referral') return 'first_time';
  if (status === 'previous_session') return null;
  return 'admin';
}
