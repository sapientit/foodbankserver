import { describe, expect, it } from 'vitest';
import { stripPiiAnswers, validateAnswers, type FieldSpec } from '../src/modules/forms/answers.ts';

function field(overrides: Partial<FieldSpec> & Pick<FieldSpec, 'key' | 'type'>): FieldSpec {
  return {
    label: overrides.key,
    isRequired: false,
    options: [],
    minValue: null,
    maxValue: null,
    maxLength: null,
    isPii: true,
    ...overrides,
  };
}

describe('answer validation', () => {
  it('accepts and trims a text answer', () => {
    const result = validateAnswers([field({ key: 'dietary_needs', type: 'text' })], {
      dietary_needs: '  no pork  ',
    });

    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({ dietary_needs: 'no pork' });
  });

  it('reports a missing required answer by key', () => {
    const result = validateAnswers(
      [field({ key: 'household_pets', type: 'text', isRequired: true })],
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ key: 'household_pets', message: 'is required' }]);
  });

  it('treats blank and whitespace as absent', () => {
    const spec = [field({ key: 'notes', type: 'text', isRequired: true })];

    expect(validateAnswers(spec, { notes: '   ' }).ok).toBe(false);
    expect(validateAnswers(spec, { notes: null }).ok).toBe(false);
    expect(validateAnswers(spec, { notes: [] }).ok).toBe(false);
  });

  it('allows an absent optional answer', () => {
    const result = validateAnswers([field({ key: 'notes', type: 'text' })], {});

    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({});
  });

  it('enforces the option list on a select', () => {
    const spec = [field({ key: 'transport', type: 'select', options: ['bus', 'walk'] })];

    expect(validateAnswers(spec, { transport: 'bus' }).ok).toBe(true);
    expect(validateAnswers(spec, { transport: 'helicopter' }).issues).toEqual([
      { key: 'transport', message: 'must be one of the offered options' },
    ]);
  });

  it('enforces the option list on every entry of a multiselect', () => {
    const spec = [field({ key: 'allergies', type: 'multiselect', options: ['nuts', 'dairy'] })];

    expect(validateAnswers(spec, { allergies: ['nuts', 'dairy'] }).answers).toEqual({
      allergies: ['nuts', 'dairy'],
    });
    expect(validateAnswers(spec, { allergies: ['nuts', 'gold'] }).ok).toBe(false);
    expect(validateAnswers(spec, { allergies: 'nuts' }).ok).toBe(false);
  });

  it('bounds a number', () => {
    const spec = [field({ key: 'pets', type: 'number', minValue: 0, maxValue: 10 })];

    expect(validateAnswers(spec, { pets: 3 }).answers).toEqual({ pets: 3 });
    expect(validateAnswers(spec, { pets: '4' }).answers).toEqual({ pets: 4 });
    expect(validateAnswers(spec, { pets: 11 }).issues[0]?.message).toBe('must be 10 or fewer');
    expect(validateAnswers(spec, { pets: -1 }).issues[0]?.message).toBe('must be 0 or more');
    expect(validateAnswers(spec, { pets: 'lots' }).issues[0]?.message).toBe('must be a number');
  });

  it('enforces a maximum length', () => {
    const spec = [field({ key: 'notes', type: 'text', maxLength: 5 })];

    expect(validateAnswers(spec, { notes: 'abcdef' }).issues[0]?.message).toBe(
      'must be 5 characters or fewer',
    );
  });

  it('requires a real boolean', () => {
    const spec = [field({ key: 'has_cooker', type: 'boolean' })];

    expect(validateAnswers(spec, { has_cooker: false }).answers).toEqual({ has_cooker: false });
    expect(validateAnswers(spec, { has_cooker: 'yes' }).ok).toBe(false);
  });

  it('drops an answer to a question that no longer exists', () => {
    // A referral submitted moments after an admin removed a question should
    // still land; the answer simply has nowhere to go.
    const result = validateAnswers([field({ key: 'kept', type: 'text' })], {
      kept: 'yes',
      removed_question: 'orphaned',
    });

    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({ kept: 'yes' });
  });

  it('never echoes the submitted value in an error', () => {
    // Answers can hold health or immigration detail. Error messages are logged
    // and returned, so they must name the field and the rule only.
    const spec = [
      field({ key: 'medical_needs', type: 'number', maxValue: 5 }),
      field({ key: 'immigration_status', type: 'select', options: ['a', 'b'] }),
    ];

    const result = validateAnswers(spec, {
      medical_needs: 'insulin dependent diabetic',
      immigration_status: 'asylum seeker awaiting decision',
    });

    const serialised = JSON.stringify(result.issues);
    expect(serialised).not.toContain('insulin');
    expect(serialised).not.toContain('asylum');
    expect(result.issues.map((i) => i.key).sort()).toEqual(['immigration_status', 'medical_needs']);
  });
});

describe('PII stripping', () => {
  it('keeps non-PII answers and removes the rest', () => {
    const fields = [
      field({ key: 'dietary_needs', type: 'text', isPii: false }),
      field({ key: 'medical_needs', type: 'text', isPii: true }),
    ];

    const kept = stripPiiAnswers(fields, {
      dietary_needs: 'no pork',
      medical_needs: 'insulin dependent',
    });

    expect(kept).toEqual({ dietary_needs: 'no pork' });
  });

  it('treats a question as PII unless told otherwise', () => {
    // The schema default is isPii = true. Being wrong in that direction keeps
    // data rather than leaking it.
    const fields = [field({ key: 'anything', type: 'text' })];

    expect(stripPiiAnswers(fields, { anything: 'sensitive' })).toEqual({});
  });
});
