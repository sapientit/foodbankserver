import { describe, expect, it } from 'vitest';
import { standardiseCategory } from '../src/modules/stock/category.ts';

describe('category standardisation', () => {
  it('title-cases a lower-case category', () => {
    expect(standardiseCategory('tinned goods')).toBe('Tinned Goods');
  });

  it('lowercases the rest of an all-caps word, deliberately flattening acronyms', () => {
    // Not a bug: the trade-off documented in category.ts is that forcing the
    // case is what stops `UHT milk` and `uht milk` becoming two categories.
    expect(standardiseCategory('UHT MILK')).toBe('Uht Milk');
  });

  it('collapses runs of whitespace between words', () => {
    expect(standardiseCategory('Tinned   Goods')).toBe('Tinned Goods');
  });

  it('trims leading and trailing whitespace', () => {
    expect(standardiseCategory('  Tinned Goods  ')).toBe('Tinned Goods');
  });

  it('capitalises the first letter, not the first character, when a word opens with punctuation', () => {
    expect(standardiseCategory('(baby) food')).toBe('(Baby) Food');
  });

  it('capitalises the first letter of a word that opens with a digit', () => {
    expect(standardiseCategory('2 for 1 offers')).toBe('2 For 1 Offers');
  });

  it('lowercases a word with no letters at all rather than throwing', () => {
    expect(standardiseCategory('100 200')).toBe('100 200');
  });

  it('is idempotent: settling an already-settled category returns it unchanged', () => {
    const settled = standardiseCategory('Tinned Goods');
    expect(standardiseCategory(settled)).toBe(settled);

    const settledBaby = standardiseCategory('(baby) food');
    expect(standardiseCategory(settledBaby)).toBe(settledBaby);
  });

  it('treats two spellings differing by more than case as genuinely different categories', () => {
    // Deliberate: 'Tins' and 'Tinned' are not merged, only case and whitespace
    // are normalised.
    expect(standardiseCategory('Tins')).not.toBe(standardiseCategory('Tinned'));
  });

  it('merges categories that differ only by case or whitespace', () => {
    expect(standardiseCategory('tinned goods')).toBe(standardiseCategory('TINNED GOODS'));
    expect(standardiseCategory('Tinned  Goods')).toBe(standardiseCategory('Tinned Goods'));
  });
});
