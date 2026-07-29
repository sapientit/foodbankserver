import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { toSafeError } from '../src/core/log.ts';
import { createDatabase } from '../src/db/client.ts';
import { formDefinitions, formFields } from '../src/db/schema/forms.ts';
import { auditEvents, referralEditKeys, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { buildTestApp, devLogin } from './helpers/app.ts';
import { setUpReferralWorld, submission } from './helpers/referral-fixtures.ts';

const db = createDatabase(env.DB);

/**
 * The D1 database is pinned to the EU jurisdiction. **Workers Logs are not.**
 * So "never log PII" is a data-protection control here, not tidiness, and it
 * needs a test that actually inspects what would be written rather than
 * trusting the type system alone.
 *
 * These are the values seeded by the fixtures; every one of them is personal
 * data and none may appear in log output or in an error response.
 */
const PII_VALUES = [
  'Alice Wintergreen',
  '12 Bramble Cottages',
  'GU1 4AA',
  '07700 900123',
  'jane@guildford.gov.uk',
  '01483 000111',
];

let logged: string[] = [];

beforeEach(async () => {
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });

  await db.delete(auditEvents);
  await db.delete(referralEditKeys);
  await db.delete(referrals);
  await db.delete(formFields);
  await db.delete(formDefinitions);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function assertNoPii(haystack: string, label: string): void {
  for (const value of PII_VALUES) {
    expect(haystack, `${label} leaked ${value}`).not.toContain(value);
  }
}

describe('personal data never reaches the logs', () => {
  it('logs nothing identifying while a referral is submitted', async () => {
    // Deliberately noisy: debug level, so every log statement in the path runs.
    const testApp = buildTestApp({
      clock: fixedClock('2026-08-04T09:00:00.000Z'),
      bindings: { LOG_LEVEL: 'debug' },
    });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    logged = [];
    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission(world)),
    });
    expect(response.status).toBe(201);

    expect(logged.length).toBeGreaterThan(0); // the path really did log
    assertNoPii(logged.join('\n'), 'submission logs');
    // What it should log instead: identifiers.
    expect(logged.join('\n')).toContain('referral submitted');
  });

  it('logs nothing identifying when a submission is rejected', async () => {
    const testApp = buildTestApp({
      clock: fixedClock('2026-08-04T09:00:00.000Z'),
      bindings: { LOG_LEVEL: 'debug' },
    });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    logged = [];
    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission(world, { referrerEmail: 'stranger@example.org' })),
    });
    expect(response.status).toBe(403);

    assertNoPii(logged.join('\n'), 'rejection logs');
    // Not even the address that was refused.
    expect(logged.join('\n')).not.toContain('stranger@example.org');
  });

  it('keeps personal data out of a validation error response', async () => {
    const testApp = buildTestApp({
      clock: fixedClock('2026-08-04T09:00:00.000Z'),
      bindings: { LOG_LEVEL: 'debug' },
    });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    logged = [];
    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        submission(world, { refereePostcode: 'X', answers: { dietary_needs: 'y'.repeat(5000) } }),
      ),
    });

    expect(response.status).toBe(400);
    const body = await response.text();

    // The response names the offending fields but not their contents.
    expect(body).toContain('refereePostcode');
    expect(body).not.toContain('yyyy');
    assertNoPii(logged.join('\n'), 'validation logs');
  });

  it('keeps personal data out of a failed referral write', async () => {
    const testApp = buildTestApp({ clock: fixedClock('2026-08-04T09:00:00.000Z') });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    const created = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission(world)),
    });
    const { id }: { id: string } = await created.json();
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));

    // Force the write to fail with the referee's details bound as parameters.
    // This is the path that matters: Drizzle's error message embeds the row,
    // and unhandled errors are logged in full.
    let thrown: unknown;
    try {
      await db.insert(referrals).values({ ...stored!, id });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // The raw error really does carry the personal data — that is the hazard.
    expect((thrown as Error).message).toContain('Alice Wintergreen');

    // ...and everything that reaches a log or a client must not.
    const safe = toSafeError(thrown);
    assertNoPii(JSON.stringify(safe), 'redacted error');

    const handler = buildTestApp({ bindings: { LOG_LEVEL: 'debug' } });
    handler.app.get('/explode', () => {
      throw thrown;
    });
    logged = [];
    const response = await handler.request('/explode');

    expect(response.status).toBe(500);
    assertNoPii(await response.text(), 'error response');
    assertNoPii(logged.join('\n'), 'error logs');
  });

  it('keeps personal data out of the audit trail', async () => {
    const testApp = buildTestApp({ clock: fixedClock('2026-08-04T09:00:00.000Z') });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    const created = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission(world)),
    });
    const { id }: { id: string } = await created.json();

    await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ refereeName: 'Bernadette Newname', refereePhone: '07700 900999' }),
    });

    const rows = await db.select().from(auditEvents);
    const serialised = JSON.stringify(rows);

    assertNoPii(serialised, 'audit trail');
    expect(serialised).not.toContain('Bernadette Newname');
    expect(serialised).not.toContain('07700 900999');
    // But it does record what changed.
    expect(serialised).toContain('refereeName');
  });
});
