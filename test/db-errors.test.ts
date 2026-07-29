import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { redactQueryParams, toSafeError } from '../src/core/log.ts';
import { createDatabase } from '../src/db/client.ts';
import { isAnyUniqueViolation, isUniqueViolation } from '../src/db/unique-violation.ts';
import { formDefinitions, formFields } from '../src/db/schema/forms.ts';

const db = createDatabase(env.DB);

/**
 * These use a real D1 failure rather than a hand-written Error, because both
 * bugs they guard against came from assuming the shape of Drizzle's error
 * rather than looking at one.
 */
async function realUniqueViolation(): Promise<unknown> {
  const now = new Date().toISOString();
  await db.insert(formDefinitions).values({
    id: 'dup-def',
    version: 9001,
    title: 'Duplicate probe',
    status: 'draft',
    publishedAt: null,
    retiredAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const field = {
    formDefinitionId: 'dup-def',
    key: 'clashing_key',
    label: 'Sensitive Person Name',
    helpText: null,
    type: 'text' as const,
    isRequired: 0,
    optionsJson: null,
    minValue: null,
    maxValue: null,
    maxLength: null,
    isPii: 1,
    displayOrder: 0,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(formFields).values({ ...field, id: 'dup-1' });
  try {
    await db.insert(formFields).values({ ...field, id: 'dup-2' });
  } catch (error) {
    return error;
  }
  throw new Error('expected the second insert to violate the unique index');
}

beforeEach(async () => {
  await db.delete(formFields);
  await db.delete(formDefinitions);
});

describe('unique violation detection', () => {
  it('sees through Drizzle’s wrapper to the SQLite message', async () => {
    const error = await realUniqueViolation();

    // The thrown error itself says nothing about a constraint — the reason the
    // naive implementation silently never matched.
    expect((error as Error).message).not.toContain('UNIQUE constraint failed');
    expect(isAnyUniqueViolation(error)).toBe(true);
  });

  it('matches on the columns SQLite names, not the index name', async () => {
    const error = await realUniqueViolation();

    expect(isUniqueViolation(error, 'form_fields.form_definition_id', 'form_fields.key')).toBe(
      true,
    );
    // SQLite never reports the index name, so matching on it must not appear
    // to work.
    expect(isUniqueViolation(error, 'idx_form_fields_key')).toBe(false);
  });

  it('does not match a constraint on different columns', async () => {
    const error = await realUniqueViolation();

    // This is what stops an unrelated conflict being swallowed as success —
    // the failure mode that would let stock move twice.
    expect(isUniqueViolation(error, 'stock_ledger.parcel_id')).toBe(false);
    expect(isUniqueViolation(error, 'form_fields.key', 'form_fields.display_order')).toBe(false);
  });

  it('is false for an ordinary error', () => {
    expect(isAnyUniqueViolation(new Error('something else'))).toBe(false);
    expect(isAnyUniqueViolation('not an error')).toBe(false);
  });
});

describe('error redaction', () => {
  it('strips bound parameters from a failed query', async () => {
    const error = await realUniqueViolation();
    const safe = toSafeError(error);

    // Drizzle embeds the row's values after `params:`. On the referrals table
    // those are a referee's name, address and phone number, and unhandled
    // errors get logged in full into Workers Logs, which are not EU-pinned.
    expect(safe.message).toContain('params: [redacted]');
    expect(safe.message).not.toContain('Sensitive Person Name');
    expect(safe.message).not.toContain('clashing_key');
  });

  it('keeps the SQL text, which is useful and carries no values', async () => {
    const safe = toSafeError(await realUniqueViolation());

    expect(safe.message).toContain('insert into');
  });

  it('surfaces the underlying cause, also redacted', async () => {
    const safe = toSafeError(await realUniqueViolation());

    expect(safe.cause).toContain('UNIQUE constraint failed');
    expect(safe.cause).not.toContain('Sensitive Person Name');
  });

  it('redacts params wherever they appear', () => {
    expect(redactQueryParams('Failed query: insert into x\nparams: Jane Smith,12 High St')).toBe(
      'Failed query: insert into x\nparams: [redacted]',
    );
    expect(redactQueryParams('no params here')).toBe('no params here');
  });

  it('handles a non-Error without throwing', () => {
    expect(toSafeError('plain string')).toEqual({
      name: 'UnknownError',
      message: 'plain string',
    });
  });
});
