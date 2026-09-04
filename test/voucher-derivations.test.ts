import { describe, expect, it } from 'vitest';
import {
  firstTimeMarkerFor,
  isWithinVoucherRange,
  voucherInstructionFor,
  type VoucherDateRange,
} from '../src/modules/voucher-config/derivations.ts';

/**
 * Pure unit tests for `derivations.ts` — no I/O, no HTTP. The exact contract
 * `test/pick-list-first-time.test.ts` proves is wired up correctly at the
 * route layer.
 */

const RANGE: VoucherDateRange = { startDate: '2026-12-01', endDate: '2026-12-24' };

describe('isWithinVoucherRange', () => {
  it('is inclusive of the start boundary', () => {
    expect(isWithinVoucherRange('2026-12-01', RANGE)).toBe(true);
  });

  it('is inclusive of the end boundary', () => {
    expect(isWithinVoucherRange('2026-12-24', RANGE)).toBe(true);
  });

  it('is true for a date strictly inside the range', () => {
    expect(isWithinVoucherRange('2026-12-10', RANGE)).toBe(true);
  });

  it('is false for a date the day before the start', () => {
    expect(isWithinVoucherRange('2026-11-30', RANGE)).toBe(false);
  });

  it('is false for a date the day after the end', () => {
    expect(isWithinVoucherRange('2026-12-25', RANGE)).toBe(false);
  });

  it('is false for a date well outside the range', () => {
    expect(isWithinVoucherRange('2026-01-01', RANGE)).toBe(false);
  });
});

describe('voucherInstructionFor', () => {
  const sessionDate = '2026-12-10';

  it('is null when no range is configured', () => {
    expect(
      voucherInstructionFor(sessionDate, undefined, {
        status: 'unreviewed',
        previousSessionDate: null,
      }),
    ).toBeNull();
  });

  it('is null when the session date falls outside a configured range', () => {
    expect(
      voucherInstructionFor('2026-01-01', RANGE, {
        status: 'unreviewed',
        previousSessionDate: null,
      }),
    ).toBeNull();
  });

  it('is refer_to_admin when the referral has not been reviewed', () => {
    expect(
      voucherInstructionFor(sessionDate, RANGE, {
        status: 'unreviewed',
        previousSessionDate: null,
      }),
    ).toBe('refer_to_admin');
  });

  it('is provide_voucher when the referral has no previous referral', () => {
    expect(
      voucherInstructionFor(sessionDate, RANGE, {
        status: 'no_previous_referral',
        previousSessionDate: null,
      }),
    ).toBe('provide_voucher');
  });

  it('is provide_voucher when the recorded previous-session date falls outside the range', () => {
    expect(
      voucherInstructionFor(sessionDate, RANGE, {
        status: 'previous_session',
        previousSessionDate: '2025-12-10',
      }),
    ).toBe('provide_voucher');
  });

  it('is already_received when the recorded previous-session date falls inside the range', () => {
    expect(
      voucherInstructionFor(sessionDate, RANGE, {
        status: 'previous_session',
        previousSessionDate: '2026-12-05',
      }),
    ).toBe('already_received');
  });

  it('is already_received when the recorded date sits exactly on the range boundary', () => {
    expect(
      voucherInstructionFor(sessionDate, RANGE, {
        status: 'previous_session',
        previousSessionDate: RANGE.endDate,
      }),
    ).toBe('already_received');
  });
});

describe('firstTimeMarkerFor', () => {
  it('reads no_previous_referral as first_time', () => {
    expect(firstTimeMarkerFor('no_previous_referral')).toBe('first_time');
  });

  it('reads unreviewed as admin', () => {
    expect(firstTimeMarkerFor('unreviewed')).toBe('admin');
  });

  it('reads previous_session as no marker at all', () => {
    expect(firstTimeMarkerFor('previous_session')).toBeNull();
  });

  it('reads undefined — a referral this could not be determined for — as admin', () => {
    expect(firstTimeMarkerFor(undefined)).toBe('admin');
  });
});
