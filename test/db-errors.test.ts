import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { redactQueryParams, toSafeError } from '../src/core/log.ts';
import { createDatabase } from '../src/db/client.ts';
import { isAnyUniqueViolation, isUniqueViolation } from '../src/db/unique-violation.ts';
import { authorisedReferrers } from '../src/db/schema/referrers.ts';
import { createPickListsRepository } from '../src/modules/pick-lists/pick-lists.repository.ts';

const db = createDatabase(env.DB);

/**
 * These use a real D1 failure rather than a hand-written Error, because both
 * bugs they guard against came from assuming the shape of Drizzle's error
 * rather than looking at one.
 *
 * `authorised_referrers` is used only because it carries a **composite** unique
 * index, which is what the column-matching rule turns on. The organisation name
 * stands in for a value that must never reach a log.
 */
async function realUniqueViolation(): Promise<unknown> {
  const now = new Date().toISOString();
  const referrer = {
    matchType: 'email' as const,
    matchValue: 'clashing_value@example.org',
    organisationName: 'Sensitive Person Name',
    isActive: 1,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(authorisedReferrers).values({ ...referrer, id: 'dup-1' });
  try {
    await db.insert(authorisedReferrers).values({ ...referrer, id: 'dup-2' });
  } catch (error) {
    return error;
  }
  throw new Error('expected the second insert to violate the unique index');
}

beforeEach(async () => {
  await db.delete(authorisedReferrers);
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

    expect(
      isUniqueViolation(
        error,
        'authorised_referrers.match_type',
        'authorised_referrers.match_value',
      ),
    ).toBe(true);
    // SQLite never reports the index name, so matching on it must not appear
    // to work.
    expect(isUniqueViolation(error, 'idx_authorised_referrers_match')).toBe(false);
  });

  it('does not match a constraint on different columns', async () => {
    const error = await realUniqueViolation();

    // This is what stops an unrelated conflict being swallowed as success —
    // the failure mode that would let stock move twice.
    expect(isUniqueViolation(error, 'stock_ledger.parcel_id')).toBe(false);
    expect(
      isUniqueViolation(
        error,
        'authorised_referrers.match_value',
        'authorised_referrers.organisation_name',
      ),
    ).toBe(false);
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
    expect(safe.message).not.toContain('clashing_value');
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

describe('a raw D1 statement failure', () => {
  /**
   * The bulk parcel insert runs through `db.$client` rather than a Drizzle
   * query builder, and since pick-list information landed it carries free text
   * about a household's allergies. Everything above pins the **Drizzle** path,
   * where the wrapper embeds the bound row after `params:` and
   * `redactQueryParams` strips it. D1's own driver is a different code path
   * whose shape nobody had looked at — which is the exact mistake the rest of
   * this file exists to guard against.
   */
  it('never carries the bound row, so a parcel note cannot reach a log', async () => {
    const repository = createPickListsRepository(db);
    const now = new Date().toISOString();
    const statement = repository.buildInsertParcels([
      {
        id: crypto.randomUUID(),
        // No such pick list and no such referral, so the insert fails on a
        // foreign key with the note bound into the statement.
        pickListId: crypto.randomUUID(),
        referralId: crypto.randomUUID(),
        pickNumber: 1,
        adults: 1,
        children: 0,
        notes: 'Allergies: EpiPen in the house',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    let thrown: unknown;
    try {
      await db.$client.batch([statement]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const safe = toSafeError(thrown);
    const stack = thrown instanceof Error ? (thrown.stack ?? '') : '';
    const everywhere = `${safe.name} ${safe.message} ${safe.cause ?? ''} ${stack}`;

    expect(everywhere).toContain('FOREIGN KEY constraint failed');
    expect(everywhere).not.toContain('EpiPen');
    expect(everywhere).not.toContain('Allergies');
  });
});
