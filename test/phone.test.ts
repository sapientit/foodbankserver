import { describe, expect, it } from 'vitest';
import { normalisePhone, phonesMatch } from '../src/core/phone.ts';

describe('normalisePhone', () => {
  it('normalises the four shapes a referrer or the provider might use', () => {
    expect(normalisePhone('07700 900123')).toBe('+447700900123');
    expect(normalisePhone('+447700900123')).toBe('+447700900123');
    expect(normalisePhone('447700900123')).toBe('+447700900123');
    expect(normalisePhone('07700900123')).toBe('+447700900123');
  });

  it('tolerates hyphens and parentheses', () => {
    expect(normalisePhone('(07700) 900-123')).toBe('+447700900123');
  });

  it('returns null for a number that is not a recognisable UK number', () => {
    expect(normalisePhone('not a number')).toBeNull();
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('+1 555 0100')).toBeNull(); // a different country code
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone('   ')).toBeNull();
  });
});

describe('phonesMatch', () => {
  it('matches two numbers written differently that are the same number', () => {
    expect(phonesMatch('07700 900123', '+447700900123')).toBe(true);
  });

  it('does not match two different numbers', () => {
    expect(phonesMatch('07700 900123', '07700 900124')).toBe(false);
  });

  it('does not match when either side cannot be normalised', () => {
    expect(phonesMatch('not a number', '+447700900123')).toBe(false);
  });
});
