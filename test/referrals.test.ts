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
  submission,
  submitReferral,
  UNKNOWN_REFERRER,
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
  await db.delete(referrals);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('public referral submission', () => {
  it('accepts a referral from an authorised domain as active', async () => {
    const { testApp, world: w } = await world();

    const { status, id, referralStatus } = await submitReferral(testApp, w);

    expect(status).toBe(201);
    expect(id).toEqual(expect.any(String));
    expect(referralStatus).toBe('active');

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.referrerOrganisation).toBe('Guildford Borough Council');
    expect(stored?.authorisedReferrerId).toEqual(expect.any(String));
    expect(stored?.adults).toBe(2);
    expect(stored?.children).toBe(3);
  });

  it('takes a referral from an unrecognised address and holds it for review', async () => {
    const { testApp, world: w } = await world();

    const { status, id, referralStatus } = await submitReferral(testApp, w, UNKNOWN_REFERRER);

    // The whole point of the change: not a 403. A household that needs feeding
    // is not turned away because the allowlist is out of date.
    expect(status).toBe(201);
    expect(referralStatus).toBe('pending_review');

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).toBe('pending_review');
    // Nothing matched, so nothing is credited — but the typed organisation is kept.
    expect(stored?.authorisedReferrerId).toBeNull();
    expect(stored?.referrerOrganisation).toBe('A Charity Nobody Has Added Yet');
  });

  it('takes the organisation from the submission, not from the matched referrer', async () => {
    const { testApp, world: w } = await world();

    // An authorised address, but the referrer typed a different organisation.
    // The string is stored as given; the match is recorded separately, so it is
    // the match and not the string that says who is credited.
    const { id } = await submitReferral(testApp, w, {
      referrerOrganisation: 'Guildford Borough Council (Housing Team)',
    });

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.referrerOrganisation).toBe('Guildford Borough Council (Housing Team)');
    expect(stored?.authorisedReferrerId).toEqual(expect.any(String));
    expect(stored?.status).toBe('active');
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

  it('creates the referral and an audit entry together', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    expect(audit[0]?.action).toBe('created');
    expect(audit[0]?.actorKind).toBe('anonymous');
  });

  it('returns a confirmation with no key or window on it', async () => {
    const { testApp, world: w } = await world();
    const { body } = await submitReferral(testApp, w);

    // The receipt is something to read, not a handle to come back with.
    expect(body).toMatchObject({
      status: 'active',
      refereeFirstName: 'Alice',
      refereeSurname: 'Wintergreen',
      refereePostcode: 'GU1 4AA',
      adults: 2,
      children: 3,
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain('editKey');
    expect(text).not.toContain('editKeyExpiresAt');
  });

  it('no longer serves the self-service read, amend or withdraw routes', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await testApp.request(`/api/v1/public/referrals/${id}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: JSON.stringify({ adults: 9 }) }),
      });
      expect(response.status).toBe(404);
    }

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adults).toBe(2);
  });

  it('stores the referee name in two parts and the date of birth as a date', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.refereeFirstName).toBe('Alice');
    expect(stored?.refereeSurname).toBe('Wintergreen');
    expect(stored?.refereeDateOfBirth).toBe('1985-03-14');
  });

  it('refuses a date of birth that is not a real date', async () => {
    const { testApp, world: w } = await world();

    const response = await submitReferral(testApp, w, { refereeDateOfBirth: '1985-02-30' });
    expect(response.status).toBe(400);
  });

  it('stores fuel help as a column, not as an answer', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w, { needsFuelHelp: true });

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.needsFuelHelp).toBe(1);
    expect(stored?.answersJson).not.toContain('needsFuelHelp');
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
});

describe('reviewing a referral', () => {
  /** A pending referral plus an admin token, which is where every test here starts. */
  async function pending(options: { capacity?: number } = {}) {
    const built = await world(options);
    const { id } = await submitReferral(built.testApp, built.world, UNKNOWN_REFERRER);
    return { ...built, id };
  }

  function adminJson(token: string): Record<string, string> {
    return { ...authHeaders(token), 'content-type': 'application/json' };
  }

  it('accepts a pending referral, recording the comment and the reviewer', async () => {
    const { testApp, token, id } = await pending();

    const response = await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: adminJson(token),
      body: JSON.stringify({ comment: 'Rang the office, she is genuine' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'active' });

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).toBe('active');
    expect(stored?.reviewComment).toBe('Rang the office, she is genuine');
    expect(stored?.reviewedByUserId).toEqual(expect.any(String));
  });

  it('rejects a pending referral and gives its place back', async () => {
    const { testApp, token, world: w, id } = await pending({ capacity: 1 });

    // The session is full while the referral waits, so nobody else can book.
    expect((await submitReferral(testApp, w)).status).toBe(409);

    const response = await testApp.request(`/api/v1/referrals/${id}/reject`, {
      method: 'POST',
      headers: adminJson(token),
      body: JSON.stringify({ comment: 'Not a referring organisation' }),
    });
    expect(response.status).toBe(200);

    // ...and the place comes back the moment it is rejected.
    expect((await submitReferral(testApp, w)).status).toBe(201);
  });

  it('reviews without a comment', async () => {
    const { testApp, token, id } = await pending();

    const response = await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(200);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.reviewComment).toBeNull();
  });

  it('refuses to review anything that is not awaiting review', async () => {
    const { testApp, token, id } = await pending();

    expect(
      (
        await testApp.request(`/api/v1/referrals/${id}/accept`, {
          method: 'POST',
          headers: authHeaders(token),
        })
      ).status,
    ).toBe(200);

    // Reviewing again would be a way of quietly reinstating a decision.
    for (const outcome of ['accept', 'reject']) {
      const again = await testApp.request(`/api/v1/referrals/${id}/${outcome}`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      expect(again.status).toBe(409);
    }
  });

  it('lets only one of two simultaneous reviews land', async () => {
    const { testApp, token, id } = await pending();

    // Two administrators working the same queue, or one double-clicking. The
    // guard is in the UPDATE, so exactly one decision can win — an accept must
    // never silently overwrite a reject, because nobody would be told.
    const [accepted, rejected] = await Promise.all([
      testApp.request(`/api/v1/referrals/${id}/accept`, {
        method: 'POST',
        headers: authHeaders(token),
      }),
      testApp.request(`/api/v1/referrals/${id}/reject`, {
        method: 'POST',
        headers: authHeaders(token),
      }),
    ]);

    const statuses = [accepted.status, rejected.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    // Whichever won, the stored status is the one that won — not a mixture, and
    // not the loser's.
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).toBe(accepted.status === 200 ? 'active' : 'rejected');

    // Exactly one decision is on the audit trail.
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    const decisions = audit.filter((row) => row.action === 'accepted' || row.action === 'rejected');
    expect(decisions).toHaveLength(1);
  });

  it('distinguishes a referral that does not exist from one already reviewed', async () => {
    const { testApp, token, id } = await pending();

    const missing = await testApp.request(`/api/v1/referrals/${crypto.randomUUID()}/accept`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(missing.status).toBe(404);

    await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    const again = await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(again.status).toBe(409);
  });

  it('refuses a comment longer than one line', async () => {
    const { testApp, token, id } = await pending();

    const response = await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: adminJson(token),
      body: JSON.stringify({ comment: 'x'.repeat(201) }),
    });

    expect(response.status).toBe(400);
  });

  it('refuses to cancel a rejected referral, so a rejection cannot be relabelled', async () => {
    const { testApp, token, id } = await pending();

    await testApp.request(`/api/v1/referrals/${id}/reject`, {
      method: 'POST',
      headers: adminJson(token),
      body: JSON.stringify({ comment: 'Not a referring organisation' }),
    });

    const cancelled = await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(cancelled.status).toBe(409);

    // The rejection, and the only record of why, must both survive.
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).toBe('rejected');
    expect(stored?.reviewComment).toBe('Not a referring organisation');
    expect(stored?.cancelledAt).toBeNull();
  });

  it('refuses a team lead reviewing', async () => {
    const { id } = await pending();

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    for (const outcome of ['accept', 'reject']) {
      const response = await lead.request(`/api/v1/referrals/${id}/${outcome}`, {
        method: 'POST',
        headers: authHeaders(accessToken),
      });
      expect(response.status).toBe(403);
    }
  });

  it('audits the decision', async () => {
    const { testApp, token, id } = await pending();

    await testApp.request(`/api/v1/referrals/${id}/reject`, {
      method: 'POST',
      headers: adminJson(token),
      body: JSON.stringify({ comment: 'Duplicate of an earlier referral' }),
    });

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    const reviewed = audit.find((row) => row.action === 'rejected');
    expect(reviewed?.actorKind).toBe('user');
    // The comment is on the referral, not smeared across the audit table.
    expect(reviewed?.detailJson).toBeNull();
  });
});

describe('what a team lead may see of a referral under review', () => {
  async function leadApp() {
    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });
    return { lead, accessToken };
  }

  it('shows a pending referral, so the lead can answer for it in the hall', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w, UNKNOWN_REFERRER);
    const { lead, accessToken } = await leadApp();

    const one = await lead.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(accessToken),
    });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ status: 'pending_review' });

    const listed = await lead.request('/api/v1/referrals', { headers: authHeaders(accessToken) });
    const body: { referrals: { id: string }[] } = await listed.json();
    expect(body.referrals.map((referral) => referral.id)).toContain(id);
  });

  it('hides a rejected referral entirely', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, UNKNOWN_REFERRER);
    await testApp.request(`/api/v1/referrals/${id}/reject`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const { lead, accessToken } = await leadApp();

    // 404, not 403: a team lead has no business learning that it exists.
    const one = await lead.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(accessToken),
    });
    expect(one.status).toBe(404);

    const listed = await lead.request('/api/v1/referrals', { headers: authHeaders(accessToken) });
    const body: { referrals: { id: string }[] } = await listed.json();
    expect(body.referrals.map((referral) => referral.id)).not.toContain(id);

    // Asking for them by name is an empty list, not an error — the status is
    // simply not one of theirs.
    const filtered = await lead.request('/api/v1/referrals?status=rejected', {
      headers: authHeaders(accessToken),
    });
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toEqual({ referrals: [] });

    // An admin still sees it.
    const asAdmin = await testApp.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(token),
    });
    expect(asAdmin.status).toBe(200);
  });

  it('withholds the review comment from a team lead', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, UNKNOWN_REFERRER);
    await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'Referrer is her ex-partner, watch this one' }),
    });

    const { lead, accessToken } = await leadApp();
    const response = await lead.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(accessToken),
    });

    const text = await response.text();
    expect(text).not.toContain('reviewComment');
    expect(text).not.toContain('ex-partner');

    // The admin does get it.
    const asAdmin = await testApp.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(token),
    });
    expect(await asAdmin.json()).toMatchObject({
      reviewComment: 'Referrer is her ex-partner, watch this one',
    });
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
      body: JSON.stringify({ refereeSurname: 'Renamed', adults: 4 }),
    });

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    const amended = audit.find((row) => row.action === 'amended');

    expect(amended?.detailJson).toContain('refereeSurname');
    expect(amended?.detailJson).toContain('adults');
    // The whole point: names of fields, never their contents.
    expect(amended?.detailJson).not.toContain('Renamed');
    expect(amended?.actorKind).toBe('user');
  });

  it('refuses to amend or move a rejected referral', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, UNKNOWN_REFERRER);
    await testApp.request(`/api/v1/referrals/${id}/reject`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const elsewhere = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-18',
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Annexe',
      }),
    });
    const { id: otherSessionId }: { id: string } = await elsewhere.json();

    // A move is an amendment, so both halves of PATCH must refuse it.
    for (const body of [{ adults: 4 }, { sessionId: otherSessionId }]) {
      const response = await testApp.request(`/api/v1/referrals/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(409);
    }

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.sessionId).toBe(w.sessionId);
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

  it('hides a session filled by referrals nobody has reviewed yet', async () => {
    const { testApp, token, world: w } = await world({ capacity: 1 });

    // A pending referral holds its place, so the session stops being offered
    // even though nobody has looked at the one referral it has.
    await submitReferral(testApp, w, UNKNOWN_REFERRER);

    const after = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: { id: string }[] } = await after.json();
    expect(body.sessions.map((s) => s.id)).not.toContain(w.sessionId);

    const listed = await testApp.request('/api/v1/sessions', { headers: authHeaders(token) });
    const staff: { sessions: { id: string; booked: number }[] } = await listed.json();
    expect(staff.sessions.find((s) => s.id === w.sessionId)?.booked).toBe(1);
  });

  it('shows a session again once a pending referral is rejected', async () => {
    const { testApp, token, world: w } = await world({ capacity: 1 });
    const { id } = await submitReferral(testApp, w, UNKNOWN_REFERRER);

    await testApp.request(`/api/v1/referrals/${id}/reject`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const after = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: { id: string }[] } = await after.json();
    expect(body.sessions.map((s) => s.id)).toContain(w.sessionId);
  });
});
