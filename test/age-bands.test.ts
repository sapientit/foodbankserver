import { describe, expect, it } from 'vitest';
import {
  deriveHousehold,
  hasSomeoneTwelveOrOver,
  type AgeBands,
} from '../src/modules/referrals/age-bands.ts';

/**
 * `src/modules/referrals/age-bands.ts` is pure, no I/O, and is what every
 * downstream household count — the grid lookup, the parcel snapshot, the
 * twelve-or-over submission rule — actually reads. `INITIAL_SPEC1.txt`, the
 * referral form section, is the requirement this proves.
 */

function bands(overrides: Partial<AgeBands> = {}): AgeBands {
  return {
    infants: 0,
    children4To11: 0,
    teenagers12To17: 0,
    adults18Plus: 0,
    ...overrides,
  };
}

describe('deriveHousehold', () => {
  it('excludes infants from both operational counts', () => {
    expect(deriveHousehold(bands({ infants: 5, adults18Plus: 1 }))).toEqual({
      adults: 1,
      children: 0,
    });
  });

  it('counts a teenager as an operational adult, not a child', () => {
    expect(deriveHousehold(bands({ teenagers12To17: 2, adults18Plus: 1 }))).toEqual({
      adults: 3,
      children: 0,
    });
  });

  it('takes children straight from the 4-11 band', () => {
    expect(deriveHousehold(bands({ children4To11: 4 }))).toEqual({ adults: 0, children: 4 });
  });

  it('is all zeros for an all-zero household', () => {
    expect(deriveHousehold(bands())).toEqual({ adults: 0, children: 0 });
  });

  it('sums teenagers and adults even when both are present alongside children and infants', () => {
    expect(
      deriveHousehold(bands({ infants: 2, children4To11: 3, teenagers12To17: 1, adults18Plus: 2 })),
    ).toEqual({ adults: 3, children: 3 });
  });
});

describe('hasSomeoneTwelveOrOver', () => {
  it('is false when both the teenager and adult bands are zero, however many infants and young children there are', () => {
    expect(
      hasSomeoneTwelveOrOver(
        bands({ infants: 4, children4To11: 4, teenagers12To17: 0, adults18Plus: 0 }),
      ),
    ).toBe(false);
  });

  it('is true at the boundary of exactly one teenager and nobody 18+', () => {
    expect(hasSomeoneTwelveOrOver(bands({ teenagers12To17: 1, adults18Plus: 0 }))).toBe(true);
  });

  it('is true for one adult and nobody else', () => {
    expect(hasSomeoneTwelveOrOver(bands({ teenagers12To17: 0, adults18Plus: 1 }))).toBe(true);
  });

  it('is false for an entirely empty household', () => {
    expect(hasSomeoneTwelveOrOver(bands())).toBe(false);
  });
});
