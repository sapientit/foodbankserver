import { describe, expect, it } from 'vitest';
import {
  hasAnythingToMatchOn,
  matchKinds,
  MATCH_KINDS,
  normalisePostcode,
  type MatchableFields,
} from '../src/modules/referrals/matching.ts';

/**
 * `src/modules/referrals/matching.ts` is pure, no I/O, and is the highest-value
 * test surface in the repeat-referral feature. `INITIAL_SPEC1.txt`,
 * `#Reviewing a referral`, is the requirement this proves.
 */

function fields(overrides: Partial<MatchableFields> = {}): MatchableFields {
  return {
    dateOfBirth: null,
    postcodeNormalised: null,
    phoneNormalised: null,
    ...overrides,
  };
}

describe('normalisePostcode', () => {
  it('settles case and missing spaces to the same value', () => {
    expect(normalisePostcode('gu1 4aa')).toBe('GU14AA');
    expect(normalisePostcode('GU14AA')).toBe('GU14AA');
    expect(normalisePostcode(' Gu1  4aA ')).toBe('GU14AA');
  });

  it('strips a non-breaking space like an ordinary one', () => {
    expect(normalisePostcode('GU1 4AA')).toBe('GU14AA');
  });

  it('accepts each of the six UK postcode shapes', () => {
    // A9 9AA
    expect(normalisePostcode('M1 1AE')).toBe('M11AE');
    // A9A 9AA
    expect(normalisePostcode('W1A 0AX')).toBe('W1A0AX');
    // A99 9AA
    expect(normalisePostcode('M60 1NW')).toBe('M601NW');
    // AA9 9AA
    expect(normalisePostcode('CR2 6XH')).toBe('CR26XH');
    // AA9A 9AA
    expect(normalisePostcode('EC1A 1BB')).toBe('EC1A1BB');
    // AA99 9AA
    expect(normalisePostcode('AB12 3CD')).toBe('AB123CD');
  });

  it('returns null for anything that is not a recognisable UK postcode', () => {
    expect(normalisePostcode('not a postcode')).toBeNull();
    expect(normalisePostcode('12345')).toBeNull();
    expect(normalisePostcode('')).toBeNull();
    expect(normalisePostcode(null)).toBeNull();
  });
});

describe('matchKinds', () => {
  it('matches on date of birth alone', () => {
    const a = fields({ dateOfBirth: '1985-03-14' });
    const b = fields({ dateOfBirth: '1985-03-14' });
    expect(matchKinds(a, b)).toEqual(['date_of_birth']);
  });

  it('matches on postcode alone', () => {
    const a = fields({ postcodeNormalised: 'GU14AA' });
    const b = fields({ postcodeNormalised: 'GU14AA' });
    expect(matchKinds(a, b)).toEqual(['postcode']);
  });

  it('matches on phone alone', () => {
    const a = fields({ phoneNormalised: '+447700900123' });
    const b = fields({ phoneNormalised: '+447700900123' });
    expect(matchKinds(a, b)).toEqual(['phone']);
  });

  it('reports all three, in MATCH_KINDS order, when all three agree', () => {
    const a: MatchableFields = {
      dateOfBirth: '1985-03-14',
      postcodeNormalised: 'GU14AA',
      phoneNormalised: '+447700900123',
    };
    const b: MatchableFields = { ...a };
    expect(matchKinds(a, b)).toEqual([...MATCH_KINDS]);
  });

  // A null never matches a null — the rule that stops every household with no
  // phone number (or no postcode the rule could place) being silently grouped
  // together. Asserted for each of the three fields separately, because losing
  // this for just one of them would still pass a test that only checked the
  // others.
  it('does not match two nulls on date of birth, even with everything else equal', () => {
    const a = fields({
      dateOfBirth: null,
      postcodeNormalised: 'GU14AA',
      phoneNormalised: '+447700900123',
    });
    const b = fields({
      dateOfBirth: null,
      postcodeNormalised: 'GU14AA',
      phoneNormalised: '+447700900123',
    });
    expect(matchKinds(a, b)).toEqual(['postcode', 'phone']);
  });

  it('does not match two nulls on postcode, even with everything else equal', () => {
    const a = fields({
      dateOfBirth: '1985-03-14',
      postcodeNormalised: null,
      phoneNormalised: '+447700900123',
    });
    const b = fields({
      dateOfBirth: '1985-03-14',
      postcodeNormalised: null,
      phoneNormalised: '+447700900123',
    });
    expect(matchKinds(a, b)).toEqual(['date_of_birth', 'phone']);
  });

  it('does not match two nulls on phone, even with everything else equal', () => {
    const a = fields({
      dateOfBirth: '1985-03-14',
      postcodeNormalised: 'GU14AA',
      phoneNormalised: null,
    });
    const b = fields({
      dateOfBirth: '1985-03-14',
      postcodeNormalised: 'GU14AA',
      phoneNormalised: null,
    });
    expect(matchKinds(a, b)).toEqual(['date_of_birth', 'postcode']);
  });

  it('does not match a present value against a null, whichever side is null', () => {
    const present = fields({ dateOfBirth: '1985-03-14' });
    const absent = fields({ dateOfBirth: null });
    expect(matchKinds(present, absent)).toEqual([]);
    expect(matchKinds(absent, present)).toEqual([]);
  });
});

describe('hasAnythingToMatchOn', () => {
  it('is true when date of birth alone is present', () => {
    expect(hasAnythingToMatchOn(fields({ dateOfBirth: '1985-03-14' }))).toBe(true);
  });

  it('is true when postcode alone is present', () => {
    expect(hasAnythingToMatchOn(fields({ postcodeNormalised: 'GU14AA' }))).toBe(true);
  });

  it('is true when phone alone is present', () => {
    expect(hasAnythingToMatchOn(fields({ phoneNormalised: '+447700900123' }))).toBe(true);
  });

  it('is false only when all three are null', () => {
    expect(hasAnythingToMatchOn(fields())).toBe(false);
  });
});
