import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { auditEvents, referralEditKeys, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  keyHeaders,
  setUpReferralWorld,
  submission,
  submitReferral,
  type ReferralWorld,
} from './helpers/referral-fixtures.ts';

const db = createDatabase(env.DB);

const NOW = '2026-08-04T09:00:00.000Z';

async function world(
  options: { capacity?: number; now?: string } = {},
): Promise<{ testApp: TestApp; token: string; world: ReferralWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(options.now ?? NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const built = await setUpReferralWorld(testApp, accessToken, options);
  return { testApp, token: accessToken, world: built };
}

beforeEach(async () => {
  await db.delete(auditEvents);
  await db.delete(referralEditKeys);
  await db.delete(referrals);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('public referral submission', () => {
  it('accepts a referral from an authorised domain', async () => {
    const { testApp, world: w } = await world();

    const { status, id, editKey } = await submitReferral(testApp, w);

    expect(status).toBe(201);
    expect(id).toEqual(expect.any(String));
    expect(editKey.length).toBeGreaterThan(30);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.referrerOrganisation).toBe('Guildford Borough Council');
    expect(stored?.adults).toBe(2);
    expect(stored?.children).toBe(3);
  });

  it('rejects an unauthorised referrer without revealing the allowlist', async () => {
    const { testApp, world: w } = await world();

    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission(w, { referrerEmail: 'stranger@example.org' })),
    });

    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain('guildford');
    expect(await db.select().from(referrals)).toHaveLength(0);
  });

  it('rejects a referral to a full session', async () => {
    const { testApp, world: w } = await world({ capacity: 2 });

    expect((await submitReferral(testApp, w)).status).toBe(201);
    expect((await submitReferral(testApp, w)).status).toBe(201);

    const third = await submitReferral(testApp, w);
    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({
      error: { code: 'CONFLICT', details: { capacity: 2, booked: 2 } },
    });
  });

  it('counts capacity in households, not people', async () => {
    const { testApp, token, world: w } = await world({ capacity: 2 });

    // Two of the largest households the grid allows — twenty people through the
    // door, and still only two of the twenty-five places used.
    const big = { adults: 5, children: 5 };
    expect((await submitReferral(testApp, w, big)).status).toBe(201);
    expect((await submitReferral(testApp, w, big)).status).toBe(201);

    const listed = await testApp.request('/api/v1/sessions', { headers: authHeaders(token) });
    const body: { sessions: { id: string; capacity: number; booked: number }[] } =
      await listed.json();
    expect(body.sessions.find((listing) => listing.id === w.sessionId)).toMatchObject({
      capacity: 2,
      booked: 2,
    });

    expect((await submitReferral(testApp, w, big)).status).toBe(409);
  });

  it('does not count a cancelled referral against capacity', async () => {
    const { testApp, token, world: w } = await world({ capacity: 1 });
    const first = await submitReferral(testApp, w);

    await testApp.request(`/api/v1/referrals/${first.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect((await submitReferral(testApp, w)).status).toBe(201);
  });

  it('rejects a referral to a cancelled session', async () => {
    const { testApp, token, world: w } = await world();
    await testApp.request(`/api/v1/sessions/${w.sessionId}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect((await submitReferral(testApp, w)).status).toBe(409);
  });

  it('refuses a retired reason for referral', async () => {
    const { testApp, token, world: w } = await world();
    await testApp.request(`/api/v1/referral-reasons/${w.reasonId}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });

    const response = await submitReferral(testApp, w);
    expect(response.status).toBe(422);
  });

  it('refuses an empty household', async () => {
    const { testApp, world: w } = await world();

    const response = await submitReferral(testApp, w, { adults: 0, children: 0 });

    expect(response.status).toBe(400);
  });

  it('stores dynamic answers as given, without a form to validate them against', async () => {
    const { testApp, world: w } = await world();

    // Keys this build has never heard of, and a value type nothing declared.
    // The form lives in the client, so none of that is the server's business.
    const answers = {
      dietary_needs: 'no pork',
      a_question_added_last_tuesday: true,
      household_pets: ['cat', 'dog'],
    };
    const { status, id } = await submitReferral(testApp, w, { answers });

    expect(status).toBe(201);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(JSON.parse(stored?.answersJson ?? 'null')).toEqual(answers);
  });

  it('returns the answers it was given', async () => {
    const { testApp, token, world: w } = await world();
    const answers = { dietary_needs: 'gluten free', delivered_before: false };
    const { id } = await submitReferral(testApp, w, { answers });

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(token),
    });

    expect(response.status).toBe(200);
    const body: { answers: unknown } = await response.json();
    expect(body.answers).toEqual(answers);
  });

  it('refuses answers too large to be a referral', async () => {
    const { testApp, world: w } = await world();

    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission(w, { answers: { notes: 'x'.repeat(20_000) } })),
    });

    // Not form validation — a bound on an unauthenticated write. The offending
    // answer must still never be echoed back.
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('xxxxx');
  });

  it('creates the referral, its edit key and an audit entry together', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    expect(await db.select().from(referralEditKeys)).toHaveLength(1);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    expect(audit[0]?.action).toBe('created');
    expect(audit[0]?.actorKind).toBe('anonymous');
  });

  it('does not persist a delivery address, because a delivery goes to the referee', async () => {
    const { testApp, token, world: w } = await world();

    // A client built against the old contract, or an attempt to have a parcel
    // delivered somewhere the charity never agreed to. Either way it is dropped.
    const { status, id } = await submitReferral(testApp, w, {
      isDelivery: true,
      deliveryAddress: '4 Riverside Flats',
    });
    expect(status).toBe(201);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.isDelivery).toBe(1);
    expect(stored?.refereeAddress).toBe('12 Bramble Cottages');
    expect(JSON.stringify(stored)).not.toContain('Riverside');

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(token),
    });
    const text = await response.text();
    expect(text).not.toContain('deliveryAddress');
    expect(text).not.toContain('Riverside');
  });

  it('stores only a hash of the edit key', async () => {
    const { testApp, world: w } = await world();
    const { editKey } = await submitReferral(testApp, w);

    const [key] = await db.select().from(referralEditKeys);
    expect(key?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(key?.keyHash).not.toBe(editKey);
  });
});

describe('the 15-minute edit window', () => {
  it('accepts an amend with a valid edit key', async () => {
    const { testApp, world: w } = await world();
    const { id, editKey } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/public/referrals/${id}`, {
      method: 'PATCH',
      headers: keyHeaders(editKey),
      body: JSON.stringify({ adults: 3 }),
    });

    expect(response.status).toBe(200);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adults).toBe(3);
  });

  it('rejects an amend sixteen minutes later', async () => {
    const { testApp, world: w } = await world();
    const { id, editKey } = await submitReferral(testApp, w);

    // A second app on a later clock, same database.
    const later = buildTestApp({ clock: fixedClock('2026-08-04T09:16:01.000Z') });
    const response = await later.request(`/api/v1/public/referrals/${id}`, {
      method: 'PATCH',
      headers: keyHeaders(editKey),
      body: JSON.stringify({ adults: 4 }),
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('15-minute window');
  });

  it('an amend does not extend the window', async () => {
    const { testApp, world: w } = await world();
    const { id, editKey } = await submitReferral(testApp, w);

    // Amend at 14 minutes — allowed, and must not push the expiry out.
    const at14 = buildTestApp({ clock: fixedClock('2026-08-04T09:14:00.000Z') });
    expect(
      (
        await at14.request(`/api/v1/public/referrals/${id}`, {
          method: 'PATCH',
          headers: keyHeaders(editKey),
          body: JSON.stringify({ adults: 3 }),
        })
      ).status,
    ).toBe(200);

    const at16 = buildTestApp({ clock: fixedClock('2026-08-04T09:16:01.000Z') });
    expect(
      (
        await at16.request(`/api/v1/public/referrals/${id}`, {
          method: 'PATCH',
          headers: keyHeaders(editKey),
          body: JSON.stringify({ adults: 4 }),
        })
      ).status,
    ).toBe(409);
  });

  it('rejects an edit key issued for a different referral', async () => {
    const { testApp, world: w } = await world();
    const first = await submitReferral(testApp, w);
    const second = await submitReferral(testApp, w, { refereeName: 'Bob Otherperson' });

    const response = await testApp.request(`/api/v1/public/referrals/${second.id}`, {
      method: 'PATCH',
      headers: keyHeaders(first.editKey),
      body: JSON.stringify({ adults: 9 }),
    });

    // 403, not 404: the caller holds a real key, so a 404 would send them
    // chasing a referral that does exist.
    expect(response.status).toBe(403);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, second.id));
    expect(stored?.adults).toBe(2);
  });

  it('rejects a made-up key', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/public/referrals/${id}`, {
      method: 'PATCH',
      headers: keyHeaders('not-a-real-key'),
      body: JSON.stringify({ adults: 9 }),
    });

    expect(response.status).toBe(403);
  });

  it('requires the key header at all', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/public/referrals/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adults: 9 }),
    });

    expect(response.status).toBe(401);
  });

  it('lets the referrer withdraw, and the key cannot be reused afterwards', async () => {
    const { testApp, world: w } = await world();
    const { id, editKey } = await submitReferral(testApp, w);

    const deleted = await testApp.request(`/api/v1/public/referrals/${id}`, {
      method: 'DELETE',
      headers: keyHeaders(editKey),
    });
    expect(deleted.status).toBe(204);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).toBe('cancelled');

    const replay = await testApp.request(`/api/v1/public/referrals/${id}`, {
      method: 'PATCH',
      headers: keyHeaders(editKey),
      body: JSON.stringify({ adults: 9 }),
    });
    expect(replay.status).toBe(403);
  });

  it('never returns the edit key on a read', async () => {
    const { testApp, world: w } = await world();
    const { id, editKey } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/public/referrals/${id}`, {
      headers: keyHeaders(editKey),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(editKey);
  });
});

describe('admin referral management', () => {
  it('omits the reason for referral from every response to a team lead', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    for (const path of [`/api/v1/referrals/${id}`, '/api/v1/referrals']) {
      const response = await lead.request(path, { headers: authHeaders(accessToken) });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).not.toContain('reasonId');
      expect(text).not.toContain(w.reasonId);
      // The referrer's own contact details are admin-only too.
      expect(text).not.toContain('jane@guildford.gov.uk');
      // But a team lead does need the household to run the session.
      expect(text).toContain('householdSize');
    }
  });

  it('gives an admin the reason and the referrer contact', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(token),
    });
    const body: { reasonId?: string; referrerEmail?: string } = await response.json();

    expect(body.reasonId).toBe(w.reasonId);
    expect(body.referrerEmail).toBe('jane@guildford.gov.uk');
  });

  it('refuses a team lead amending or cancelling', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const patch = await lead.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({ adults: 9 }),
    });
    const cancel = await lead.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });

    expect(patch.status).toBe(403);
    expect(cancel.status).toBe(403);
  });

  it('refuses to move a referral into a full session without acknowledgement', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const full = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-18',
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Annexe',
        capacity: 0,
      }),
    });
    const { id: fullSessionId }: { id: string } = await full.json();

    const refused = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: fullSessionId }),
    });
    expect(refused.status).toBe(409);

    const allowed = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: fullSessionId, acknowledgeOverCapacity: true }),
    });
    expect(allowed.status).toBe(200);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.sessionId).toBe(fullSessionId);
  });

  it('audits which fields changed but never their values', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ refereeName: 'Alice Renamed', adults: 4 }),
    });

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    const amended = audit.find((row) => row.action === 'amended');

    expect(amended?.detailJson).toContain('refereeName');
    expect(amended?.detailJson).toContain('adults');
    // The whole point: names of fields, never their contents.
    expect(amended?.detailJson).not.toContain('Alice');
    expect(amended?.actorKind).toBe('user');
  });
});

describe('public session availability with referrals', () => {
  it('hides a session once it is full', async () => {
    const { testApp, world: w } = await world({ capacity: 1 });

    const before = await testApp.request('/api/v1/public/sessions');
    const beforeBody: { sessions: { id: string }[] } = await before.json();
    expect(beforeBody.sessions.map((s) => s.id)).toContain(w.sessionId);

    await submitReferral(testApp, w);

    const after = await testApp.request('/api/v1/public/sessions');
    const afterBody: { sessions: { id: string }[] } = await after.json();
    expect(afterBody.sessions.map((s) => s.id)).not.toContain(w.sessionId);
  });

  it('shows a session again once a referral is cancelled', async () => {
    const { testApp, token, world: w } = await world({ capacity: 1 });
    const { id } = await submitReferral(testApp, w);

    await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const after = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: { id: string }[] } = await after.json();
    expect(body.sessions.map((s) => s.id)).toContain(w.sessionId);
  });
});
