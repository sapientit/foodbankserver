import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  setUpReferralWorld,
  submitReferral,
  type ReferralWorld,
} from './helpers/referral-fixtures.ts';

/**
 * The two rules `INITIAL_SPEC1.txt` states and the code did not enforce:
 * a confirmed session is sealed, and a session with households on it cannot be
 * cancelled.
 *
 * Both are guards, and a guard nobody has watched fail is a guard nobody knows
 * fires — so each refusal is tested against the state that should be allowed
 * as well as the state that should not.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

async function adminWorld(): Promise<{
  testApp: TestApp;
  token: string;
  world: ReferralWorld;
}> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const world = await setUpReferralWorld(testApp, accessToken);
  return { testApp, token: accessToken, world };
}

/** A second session to move households onto. */
async function anotherSession(testApp: TestApp, token: string): Promise<string> {
  const response = await testApp.request('/api/v1/sessions', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      sessionDate: '2026-08-18',
      startTime: '10:00',
      durationMinutes: 120,
      location: 'Church Hall',
      capacity: 25,
      deliveryCapacity: 25,
    }),
  });
  expect(response.status).toBe(201);
  const { id }: { id: string } = await response.json();
  return id;
}

/**
 * Confirms a session that never had a pick list.
 *
 * `confirmSession` only checks for unmarked households when a pick list
 * exists, so this is the shortest honest route to a confirmed session — and
 * these tests are about what happens *after* confirmation, not about how it is
 * reached.
 */
async function confirmSession(testApp: TestApp, token: string, sessionId: string): Promise<void> {
  const response = await testApp.request(`/api/v1/sessions/${sessionId}/confirm`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
}

async function cancelSession(testApp: TestApp, token: string, sessionId: string, reason: string) {
  const response = await testApp.request(`/api/v1/sessions/${sessionId}/cancel`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ reason }),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  await db.delete(auditEvents);
  await db.delete(referrals);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('a confirmed session is sealed', () => {
  it('refuses an amendment to a referral on it', async () => {
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world);
    await confirmSession(testApp, token, world.sessionId);

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ answers: { Other: 'Rang to say the door code changed' } }),
    });

    expect(response.status).toBe(409);
    const body: { error: { message: string } } = await response.json();
    expect(body.error.message).toMatch(/confirmed/i);

    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(row?.answersJson).not.toContain('door code'); // Untouched.
  });

  it('refuses cancelling a referral on it', async () => {
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world);
    await confirmSession(testApp, token, world.sessionId);

    const response = await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ reason: 'Changed their mind' }),
    });

    expect(response.status).toBe(409);
    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(row?.status).toBe('active');
  });

  /**
   * The one that matters most for the Google Sheets export: a household moved
   * off a confirmed session would be exported under both sessions, and the
   * export's marker cannot prevent it because the marker sits on the session.
   */
  it('refuses moving a referral off it', async () => {
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world);
    const elsewhere = await anotherSession(testApp, token);
    await confirmSession(testApp, token, world.sessionId);

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ sessionId: elsewhere, acknowledgeOverCapacity: true }),
    });

    expect(response.status).toBe(409);
    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(row?.sessionId).toBe(world.sessionId);
  });

  it('still allows all three while the session is open', async () => {
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world);

    const amended = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ answers: { Other: 'Rang to say the door code changed' } }),
    });
    expect(amended.status).toBe(200);

    const cancelled = await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ reason: 'Changed their mind' }),
    });
    expect(cancelled.status).toBe(200);
  });
});

describe('a session cannot be cancelled with households on it', () => {
  it('refuses, and says how many are in the way', async () => {
    const { testApp, token, world } = await adminWorld();
    await submitReferral(testApp, world, {}, { clientIp: '203.0.113.1' });
    await submitReferral(testApp, world, {}, { clientIp: '203.0.113.2' });

    const { status, body } = await cancelSession(testApp, token, world.sessionId, 'Hall flooded');

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: { details: { booked: 2 } } });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, world.sessionId));
    expect(row?.status).not.toBe('cancelled');
  });

  it('counts a household awaiting review, because it may still turn up', async () => {
    const { testApp, token, world } = await adminWorld();
    await submitReferral(testApp, world, {
      referrerEmail: 'someone@notonthelist.example',
      referrerOrganisation: 'A Charity Nobody Has Added Yet',
    });

    const { status } = await cancelSession(testApp, token, world.sessionId, 'Hall flooded');

    expect(status).toBe(409);
  });

  it('allows it once every household has been dealt with', async () => {
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world);

    const refused = await cancelSession(testApp, token, world.sessionId, 'Hall flooded');
    expect(refused.status).toBe(409);

    await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ reason: 'Moved to next week' }),
    });

    const { status } = await cancelSession(testApp, token, world.sessionId, 'Hall flooded');
    expect(status).toBe(200);

    const [row] = await db.select().from(sessions).where(eq(sessions.id, world.sessionId));
    expect(row?.status).toBe('cancelled');
  });

  it('allows cancelling an empty session', async () => {
    const { testApp, token, world } = await adminWorld();

    const { status } = await cancelSession(testApp, token, world.sessionId, 'Hall flooded');

    expect(status).toBe(200);
  });
});
