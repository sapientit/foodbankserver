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
  type ReferralWorld,
} from './helpers/referral-fixtures.ts';

/**
 * `assertNotPurged` — a referral whose details have been forgotten cannot be
 * acted on at all: no amend, no move, no cancel, no accept, no reject, no
 * mark-reviewed and no copy. `INITIAL_SPEC1.txt`, `#Referral maintenance`:
 * "twelve months on there is no name, no address and no answers left, so
 * there is nothing to correct... nothing to move... nothing to cancel and
 * nothing to copy."
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

/** Submits a referral, ages it past retention and runs the real purge job —
 *  the same one the nightly cron calls — rather than hand-editing the row. */
async function purgedReferral(): Promise<{ testApp: TestApp; token: string; id: string }> {
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
    retentionDays: 365,
  });
  expect(result.purged).toBe(1);

  return { testApp, token, id };
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

describe('a forgotten referral cannot be acted on', () => {
  it('refuses to amend it', async () => {
    const { testApp, token, id } = await purgedReferral();

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ adults: 4 }),
    });

    expect(response.status).toBe(409);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adults).not.toBe(4);
  });

  it('refuses to move it to another session', async () => {
    const { testApp, token, id } = await purgedReferral();

    const other = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        sessionDate: '2026-08-18',
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Annexe',
      }),
    });
    const { id: otherSessionId }: { id: string } = await other.json();

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ sessionId: otherSessionId }),
    });

    expect(response.status).toBe(409);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.sessionId).not.toBe(otherSessionId);
  });

  it('refuses to cancel it', async () => {
    const { testApp, token, id } = await purgedReferral();

    const response = await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(409);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).not.toBe('cancelled');
    expect(stored?.cancelledAt).toBeNull();
  });

  it('refuses to mark it reviewed', async () => {
    const { testApp, token, id } = await purgedReferral();

    const response = await testApp.request(`/api/v1/referrals/${id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(409);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    // Still `active`: a live referral would ordinarily move to `reviewed`.
    expect(stored?.status).toBe('active');
  });

  it('refuses to copy it even when it would otherwise be eligible', async () => {
    // **The referral is cancelled before it is purged, deliberately.** Copying
    // an `active` referral is refused by the eligibility rule whatever the
    // purge says, so purging one of those would prove nothing: the test would
    // still pass with `assertNotPurged` deleted from `copy` altogether. A
    // cancelled referral passes eligibility, so the only thing that can refuse
    // this one is the purge guard.
    const { testApp, token, world: w } = await world();
    const { id, referralStatus } = await submitReferral(testApp, w);
    expect(referralStatus).toBe('active');

    const cancelled = await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(cancelled.status).toBe(200);

    await db
      .update(referrals)
      .set({ referredAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(referrals.id, id));
    const result = await purgeReferralPii({
      db,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
      retentionDays: 365,
    });
    expect(result.purged).toBe(1);

    const other = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        sessionDate: '2026-08-18',
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Annexe',
      }),
    });
    const { id: otherSessionId }: { id: string } = await other.json();

    const response = await testApp.request(`/api/v1/referrals/${id}/copy`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ sessionId: otherSessionId }),
    });

    expect(response.status).toBe(409);
    // And nothing was created: the copy would have been a second referral on
    // the other session.
    const rows = await db.select().from(referrals).where(eq(referrals.sessionId, otherSessionId));
    expect(rows).toHaveLength(0);
  });

  it('refuses to accept it', async () => {
    // Accept and reject both require `pending_review`, so this needs its own
    // referral rather than reusing `purgedReferral`'s already-active one.
    const { testApp, token, world: w } = await world();
    const held = await submitReferral(testApp, w, {
      referrerEmail: 'someone@notonthelist.example',
      referrerOrganisation: 'A Charity Nobody Has Added Yet',
    });
    expect(held.referralStatus).toBe('pending_review');

    await db
      .update(referrals)
      .set({ referredAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(referrals.id, held.id));
    await purgeReferralPii({
      db,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
      retentionDays: 365,
    });

    const response = await testApp.request(`/api/v1/referrals/${held.id}/accept`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(409);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, held.id));
    expect(stored?.status).toBe('pending_review');
  });

  it('refuses to reject it', async () => {
    const { testApp, token, world: w } = await world();
    const held = await submitReferral(testApp, w, {
      referrerEmail: 'someone@notonthelist.example',
      referrerOrganisation: 'A Charity Nobody Has Added Yet',
    });
    expect(held.referralStatus).toBe('pending_review');

    await db
      .update(referrals)
      .set({ referredAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(referrals.id, held.id));
    await purgeReferralPii({
      db,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
      retentionDays: 365,
    });

    const response = await testApp.request(`/api/v1/referrals/${held.id}/reject`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(409);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, held.id));
    expect(stored?.status).toBe('pending_review');
  });
});
