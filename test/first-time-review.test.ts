import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createLogger } from '../src/core/log.ts';
import { createDatabase } from '../src/db/client.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { purgeReferralPii } from '../src/modules/jobs/purge-pii.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  setUpReferralWorld,
  submitReferral,
  UNKNOWN_REFERRER,
  type ReferralWorld,
} from './helpers/referral-fixtures.ts';

/**
 * `POST /referrals/{id}/first-time-review` and `ReferralResponse.firstTimeReview`
 * — `INITIAL_SPEC1.txt`, `#Christmas voucher and first-time selection`.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

async function world(): Promise<{ testApp: TestApp; token: string; world: ReferralWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const built = await setUpReferralWorld(testApp, accessToken);
  return { testApp, token: accessToken, world: built };
}

async function leadOf(testApp: TestApp): Promise<string> {
  const { accessToken } = await devLogin(testApp, {
    email: 'lead@foodbank.org',
    role: 'team_lead',
  });
  return accessToken;
}

beforeEach(async () => {
  await db.delete(stockLedger);
  await db.delete(parcelLines);
  await db.delete(parcels);
  await db.delete(pickLists);
  await db.delete(parcelGrid);
  await db.delete(modelParcels);
  await db.delete(auditEvents);
  await db.delete(referrals);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(stockItems);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('ReferralResponse.firstTimeReview', () => {
  it('reads unreviewed with no date for a freshly submitted referral, for an admin', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(token),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      firstTimeReview: { status: 'unreviewed', previousSessionDate: null },
    });
  });

  it('is absent, not null, for a team lead on GET /referrals/{id}', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    const leadToken = await leadOf(testApp);

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(leadToken),
    });

    expect(response.status).toBe(200);
    const body: Record<string, unknown> = await response.json();
    expect(body).not.toHaveProperty('firstTimeReview');
  });

  it('is absent, not null, for a team lead on the referral list', async () => {
    const { testApp, world: w } = await world();
    await submitReferral(testApp, w);
    const leadToken = await leadOf(testApp);

    const response = await testApp.request('/api/v1/referrals', {
      headers: authHeaders(leadToken),
    });

    expect(response.status).toBe(200);
    const body: { referrals: Record<string, unknown>[] } = await response.json();
    expect(body.referrals).not.toHaveLength(0);
    for (const referral of body.referrals) {
      expect(referral).not.toHaveProperty('firstTimeReview');
    }
  });

  it('carries firstTimeReview for an admin on the referral list too', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w);

    const response = await testApp.request('/api/v1/referrals', {
      headers: authHeaders(token),
    });

    const body: { referrals: { firstTimeReview?: unknown }[] } = await response.json();
    expect(body.referrals).not.toHaveLength(0);
    expect(body.referrals[0]?.firstTimeReview).toEqual({
      status: 'unreviewed',
      previousSessionDate: null,
    });
  });
});

describe('POST /referrals/{id}/first-time-review', () => {
  it('records no previous referral, with a null date', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/referrals/${id}/first-time-review`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ noPreviousReferral: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      firstTimeReview: { status: 'no_previous_referral', previousSessionDate: null },
    });

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.firstTimeReviewStatus).toBe('no_previous_referral');
    expect(stored?.firstTimeReviewDate).toBeNull();
  });

  it('records a previous-session date', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/referrals/${id}/first-time-review`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ previousSessionDate: '2026-01-05' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      firstTimeReview: { status: 'previous_session', previousSessionDate: '2026-01-05' },
    });

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.firstTimeReviewStatus).toBe('previous_session');
    expect(stored?.firstTimeReviewDate).toBe('2026-01-05');
  });

  it('rejects a body carrying both choices', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/referrals/${id}/first-time-review`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ noPreviousReferral: true, previousSessionDate: '2026-01-05' }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects a body carrying neither choice', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/referrals/${id}/first-time-review`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it('refuses a team lead', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    const leadToken = await leadOf(testApp);

    const response = await testApp.request(`/api/v1/referrals/${id}/first-time-review`, {
      method: 'POST',
      headers: json(leadToken),
      body: JSON.stringify({ noPreviousReferral: true }),
    });

    expect(response.status).toBe(403);
  });

  it('404s for an unknown referral', async () => {
    const { testApp, token } = await world();

    const response = await testApp.request(
      `/api/v1/referrals/${crypto.randomUUID()}/first-time-review`,
      {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ noPreviousReferral: true }),
      },
    );

    expect(response.status).toBe(404);
  });

  it('refuses a referral whose details have been forgotten', async () => {
    const { testApp, token, world: w } = await world();
    const { id, referralStatus } = await submitReferral(testApp, w);
    expect(referralStatus).toBe('active');

    await db
      .update(referrals)
      .set({ referredAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(referrals.id, id));
    const result = await purgeReferralPii({
      db,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
      retentionDays: 456,
    });
    expect(result.purged).toBe(1);

    const response = await testApp.request(`/api/v1/referrals/${id}/first-time-review`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ noPreviousReferral: true }),
    });

    expect(response.status).toBe(409);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    // Untouched by the refused write.
    expect(stored?.firstTimeReviewStatus).toBe('unreviewed');
  });

  it('is not refused for a rejected referral — settled by Pete, closed Q49', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, UNKNOWN_REFERRER);

    const rejected = await testApp.request(`/api/v1/referrals/${id}/reject`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({}),
    });
    expect(rejected.status).toBe(200);

    const response = await testApp.request(`/api/v1/referrals/${id}/first-time-review`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ noPreviousReferral: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'rejected',
      firstTimeReview: { status: 'no_previous_referral', previousSessionDate: null },
    });
  });

  it('is not refused for a cancelled referral — settled by Pete, closed Q49', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const cancelled = await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({}),
    });
    expect(cancelled.status).toBe(200);

    const response = await testApp.request(`/api/v1/referrals/${id}/first-time-review`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ previousSessionDate: '2026-01-05' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'cancelled',
      firstTimeReview: { status: 'previous_session', previousSessionDate: '2026-01-05' },
    });
  });

  it('survives the fifteen-month PII purge, unlike the referee’s own fields', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    await testApp.request(`/api/v1/referrals/${id}/first-time-review`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ previousSessionDate: '2026-01-05' }),
    });

    await db
      .update(referrals)
      .set({ referredAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(referrals.id, id));
    const result = await purgeReferralPii({
      db,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
      retentionDays: 456,
    });
    expect(result.purged).toBe(1);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.piiPurgedAt).not.toBeNull();
    expect(stored?.refereeFirstName).toBeNull();
    // Outside the purged set, like `reasonId` — only identifying in
    // combination with the columns purged above.
    expect(stored?.firstTimeReviewStatus).toBe('previous_session');
    expect(stored?.firstTimeReviewDate).toBe('2026-01-05');
  });
});

describe('migration 0033 backfill', () => {
  /**
   * Only the `UPDATE` statement from the real migration — the `CREATE TABLE`
   * and `ALTER TABLE` statements already ran once via `test/setup.ts` and
   * would error a second time. Reading it out of `env.TEST_MIGRATIONS` rather
   * than retyping the SQL is the point: a test that restated the statement
   * would prove nothing about the one actually shipped.
   */
  function backfillStatements(): string[] {
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith('0033'));
    if (migration === undefined) {
      throw new Error('migration 0033 not found in TEST_MIGRATIONS — has it been renamed?');
    }
    return migration.queries.filter((query) => query.trim().toUpperCase().startsWith('UPDATE'));
  }

  async function runBackfill(): Promise<void> {
    for (const statement of backfillStatements()) {
      await env.DB.prepare(statement).run();
    }
  }

  /**
   * A referral inserted directly through Drizzle with `firstTimeReviewStatus:
   * 'unreviewed'` — simulating the state a row would have been in immediately
   * after the column was added by its own `DEFAULT 'unreviewed'`, before the
   * migration's one-off backfill `UPDATE` swept every existing row to
   * `no_previous_referral`.
   */
  async function seedRawReferral(w: ReferralWorld): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(referrals).values({
      id,
      sessionId: w.sessionId,
      status: 'active',
      referredAt: NOW,
      cancelledAt: null,
      cancelledReason: null,
      reviewComment: null,
      reviewedByUserId: null,
      referrerOrganisation: 'Backfill Test Org',
      authorisedReferrerId: null,
      adults: 1,
      children: 0,
      isDelivery: 0,
      collectionMethod: 'collection',
      firstTimeReviewStatus: 'unreviewed',
      firstTimeReviewDate: null,
      reasonId: w.reasonId,
      needsFuelHelp: 0,
      referrerName: null,
      referrerEmail: null,
      referrerPhone: null,
      refereeFirstName: null,
      refereeSurname: null,
      refereeDateOfBirth: null,
      refereeAddress: null,
      refereePostcode: null,
      refereePhone: null,
      refereePostcodeNormalised: null,
      refereePhoneNormalised: null,
      answersJson: null,
      piiPurgedAt: null,
      createdByUserId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return id;
  }

  it('sweeps a pre-existing unreviewed row to no_previous_referral', async () => {
    const { world: w } = await world();
    const id = await seedRawReferral(w);

    const before = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(before[0]?.firstTimeReviewStatus).toBe('unreviewed');

    await runBackfill();

    const after = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(after[0]?.firstTimeReviewStatus).toBe('no_previous_referral');
    expect(after[0]?.firstTimeReviewDate).toBeNull();
  });
});
