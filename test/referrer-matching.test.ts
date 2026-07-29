import { describe, expect, it } from 'vitest';
import {
  domainOf,
  matchCandidates,
  normaliseMatchValue,
  resolveAuthorisation,
  type ReferrerCandidate,
} from '../src/modules/referrers/matching.ts';

const domainRow: ReferrerCandidate = {
  id: 'row-domain',
  matchType: 'domain',
  matchValue: 'guildford.gov.uk',
  organisationName: 'Guildford Borough Council',
  isActive: 1,
};

const exactRow: ReferrerCandidate = {
  id: 'row-exact',
  matchType: 'email',
  matchValue: 'jane@guildford.gov.uk',
  organisationName: 'Guildford Housing Team',
  isActive: 1,
};

describe('referrer matching', () => {
  it('authorises an exact email', () => {
    const result = resolveAuthorisation('jane@guildford.gov.uk', [exactRow]);

    expect(result.authorised).toBe(true);
    expect(result.organisationName).toBe('Guildford Housing Team');
  });

  it('authorises any address on an authorised domain', () => {
    const result = resolveAuthorisation('anyone@guildford.gov.uk', [domainRow]);

    expect(result.authorised).toBe(true);
    expect(result.organisationName).toBe('Guildford Borough Council');
  });

  it('prefers the exact entry over the domain entry', () => {
    const result = resolveAuthorisation('jane@guildford.gov.uk', [domainRow, exactRow]);

    expect(result.organisationName).toBe('Guildford Housing Team');
    expect(result.matchedId).toBe('row-exact');
  });

  it('an inactive exact entry blocks an otherwise authorised domain', () => {
    // Jane has left the council. Deactivating her address must not fall
    // through to the still-active domain rule.
    const blocked = { ...exactRow, isActive: 0 };

    const result = resolveAuthorisation('jane@guildford.gov.uk', [domainRow, blocked]);

    expect(result.authorised).toBe(false);
    expect(result.organisationName).toBeNull();

    // Her colleagues are unaffected.
    expect(resolveAuthorisation('bob@guildford.gov.uk', [domainRow, blocked]).authorised).toBe(
      true,
    );
  });

  it('refuses an inactive domain', () => {
    const result = resolveAuthorisation('anyone@guildford.gov.uk', [{ ...domainRow, isActive: 0 }]);

    expect(result.authorised).toBe(false);
  });

  it('refuses an address with no matching entry', () => {
    expect(resolveAuthorisation('someone@elsewhere.org', [domainRow]).authorised).toBe(false);
  });

  it('is case and whitespace insensitive', () => {
    expect(resolveAuthorisation('  JANE@Guildford.GOV.uk ', [exactRow]).authorised).toBe(true);
    expect(resolveAuthorisation('ANYONE@GUILDFORD.GOV.UK', [domainRow]).authorised).toBe(true);
  });

  it('does not treat a lookalike domain as a match', () => {
    // The suffix trap: notguildford.gov.uk must not match guildford.gov.uk.
    expect(resolveAuthorisation('a@notguildford.gov.uk', [domainRow]).authorised).toBe(false);
    expect(resolveAuthorisation('a@guildford.gov.uk.evil.com', [domainRow]).authorised).toBe(false);
  });

  it('extracts the domain after the last @', () => {
    expect(domainOf('jane@guildford.gov.uk')).toBe('guildford.gov.uk');
    expect(domainOf('odd"@"name@example.org')).toBe('example.org');
    expect(domainOf('nodomain')).toBeUndefined();
    expect(domainOf('@leading')).toBeUndefined();
  });

  it('offers both candidates to the repository so the lookup is one query', () => {
    expect(matchCandidates('Jane@Guildford.gov.uk')).toEqual({
      email: 'jane@guildford.gov.uk',
      domain: 'guildford.gov.uk',
    });
  });

  it('accepts the UI’s wildcard spelling of a domain rule', () => {
    expect(normaliseMatchValue('domain', '*@guildford.gov.uk')).toBe('guildford.gov.uk');
    expect(normaliseMatchValue('domain', '@guildford.gov.uk')).toBe('guildford.gov.uk');
    expect(normaliseMatchValue('domain', 'Guildford.GOV.uk')).toBe('guildford.gov.uk');
    expect(normaliseMatchValue('email', ' Jane@Guildford.gov.uk ')).toBe('jane@guildford.gov.uk');
  });
});
