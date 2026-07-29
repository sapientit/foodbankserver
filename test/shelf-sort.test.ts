import { describe, expect, it } from 'vitest';
import { compareShelfNumbers, shelfSortKey } from '../src/modules/stock/shelf-sort.ts';

describe('shelf ordering', () => {
  it('orders A2 before A10', () => {
    // The whole reason this module exists: plain text ordering sends a picker
    // up and down the aisle.
    expect(compareShelfNumbers('A2', 'A10')).toBeLessThan(0);
    // What we are correcting: plain string ordering puts A10 first.
    expect(['A10', 'A2'].sort()).toEqual(['A10', 'A2']);
  });

  it('sorts a realistic warehouse into walking order', () => {
    const shelves = ['B1', 'A10', 'A2', 'A1', 'B2', 'A20', 'C1', 'A3'];

    expect([...shelves].sort(compareShelfNumbers)).toEqual([
      'A1',
      'A2',
      'A3',
      'A10',
      'A20',
      'B1',
      'B2',
      'C1',
    ]);
  });

  it('handles numbers before letters, as in 12b', () => {
    const shelves = ['12b', '2a', '12a', '2b'];

    expect([...shelves].sort(compareShelfNumbers)).toEqual(['2a', '2b', '12a', '12b']);
  });

  it('is case insensitive', () => {
    expect(shelfSortKey('a1')).toBe(shelfSortKey('A1'));
    expect(compareShelfNumbers('a2', 'A10')).toBeLessThan(0);
  });

  it('treats leading zeros as insignificant', () => {
    expect(shelfSortKey('A007')).toBe(shelfSortKey('A7'));
    expect(compareShelfNumbers('A007', 'A7')).toBe(0);
  });

  it('copes with purely numeric and purely alphabetic shelves', () => {
    expect([...['10', '2', '1']].sort(compareShelfNumbers)).toEqual(['1', '2', '10']);
    expect([...['Cold', 'Ambient']].sort(compareShelfNumbers)).toEqual(['Ambient', 'Cold']);
  });

  it('keeps genuinely different shelves apart', () => {
    // The separator is what stops a numeric run merging with the letters
    // beside it, so A1 and A10 cannot collide.
    expect(shelfSortKey('A1')).not.toBe(shelfSortKey('A10'));
    expect(shelfSortKey('A1B')).not.toBe(shelfSortKey('AB1'));
  });

  it('treats internal whitespace as insignificant', () => {
    // 'A1 B' and 'A1B' are the same physical shelf written two ways, so they
    // sort together rather than appearing as separate locations.
    expect(shelfSortKey('A1 B')).toBe(shelfSortKey('A1B'));
  });

  it('survives an empty or whitespace shelf number', () => {
    expect(shelfSortKey('')).toBe('');
    expect(shelfSortKey('   ')).toBe('');
  });
});
