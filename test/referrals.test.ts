import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { ConflictError } from '../src/core/errors.ts';
import { createLogger } from '../src/core/log.ts';
import { createDatabase } from '../src/db/client.ts';
import { auditEvents, referrals, type Referral } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { createReferralsRepository } from '../src/modules/referrals/referrals.repository.ts';
import { createReferralsService } from '../src/modules/referrals/referrals.service.ts';
import { createReferrersRepository } from '../src/modules/referrers/referrers.repository.ts';
import { createReferrersService } from '../src/modules/referrers/referrers.service.ts';
import { createSessionsRepository } from '../src/modules/sessions/sessions.repository.ts';
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

describe("the household's four age bands", () => {
  it('stores all four bands as submitted, and derives adults and children alongside', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w, {
      infants: 1,
      children4To11: 2,
      teenagers12To17: 1,
      adults18Plus: 2,
    });

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored).toMatchObject({
      infants: 1,
      children4To11: 2,
      teenagers12To17: 1,
      adults18Plus: 2,
      // Derived: `children` is the 4-11 count, `adults` is teenagers plus 18+.
      adults: 3,
      children: 2,
    });
  });

  it('carries the four bands and the derived trio on both the response and the receipt, and excludes infants from householdSize', async () => {
    const { testApp, token, world: w } = await world();
    const { id, body: receipt } = await submitReferral(testApp, w, {
      infants: 4,
      children4To11: 2,
      teenagers12To17: 1,
      adults18Plus: 2,
    });

    expect(receipt).toMatchObject({
      infants: 4,
      children4To11: 2,
      teenagers12To17: 1,
      adults18Plus: 2,
      adults: 3,
      children: 2,
    });

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(token),
    });
    const detail: {
      infants: number;
      children4To11: number;
      teenagers12To17: number;
      adults18Plus: number;
      adults: number;
      children: number;
      householdSize: number;
    } = await response.json();
    expect(detail).toMatchObject({
      infants: 4,
      children4To11: 2,
      teenagers12To17: 1,
      adults18Plus: 2,
      adults: 3,
      children: 2,
    });
    // 3 + 2, not 3 + 2 + 4: infants are collected and change nothing operational.
    expect(detail.householdSize).toBe(5);
  });

  it('refuses a submission missing one of the four bands', async () => {
    const { testApp, world: w } = await world();
    const { infants: _infants, ...withoutInfants } = submission(w);

    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(withoutInfants),
    });
    expect(response.status).toBe(400);
  });

  it.each([['infants'], ['children4To11'], ['teenagers12To17'], ['adults18Plus']] as const)(
    'rejects a non-integer, a negative, and 31 for %s',
    async (band) => {
      const { testApp, world: w } = await world();

      for (const value of [1.5, -1, 31]) {
        const response = await submitReferral(testApp, w, { [band]: value });
        expect(response.status, `${band} = ${String(value)}`).toBe(400);
      }
    },
  );
});

describe('the twelve-or-over rule', () => {
  it('refuses a household with nobody twelve or over, whatever the younger bands are', async () => {
    const { testApp, world: w } = await world();

    // Several infants and several 4-11 children: the household this rule
    // exists for, not merely an empty one.
    const response = await submitReferral(testApp, w, {
      teenagers12To17: 0,
      adults18Plus: 0,
      infants: 4,
      children4To11: 4,
    });

    expect(response.status).toBe(400);
  });

  it('accepts a teenager alone, with nobody eighteen or over', async () => {
    const { testApp, world: w } = await world();

    const response = await submitReferral(testApp, w, { teenagers12To17: 1, adults18Plus: 0 });

    expect(response.status).toBe(201);
  });

  it('carries the exact issue message and never echoes the submitted values', async () => {
    const { testApp, world: w } = await world();

    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        submission(w, { teenagers12To17: 0, adults18Plus: 0, infants: 0, children4To11: 0 }),
      ),
    });

    expect(response.status).toBe(400);
    const body: { error: { details: { issues: { path: string; message: string }[] } } } =
      await response.json();
    expect(body.error.details.issues).toContainEqual({
      path: '',
      message: 'a household must include at least one person aged 12 or over',
    });

    // The offending values must not come back — error bodies get logged.
    const text = JSON.stringify(body);
    expect(text).not.toContain('Wintergreen');
    expect(text).not.toContain('12 Bramble Cottages');
    expect(text).not.toContain('GU1 4AA');
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

  // --- The second accept button: accept, and authorise the referrer. ---

  it('accepts and puts the referrer on the list, by address and not by domain', async () => {
    const { testApp, token, world: w, id } = await pending();

    const response = await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: adminJson(token),
      body: JSON.stringify({
        authoriseReferrer: { organisationName: 'A Charity, Properly Named' },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'active' });

    const rules = await db.select().from(authorisedReferrers);
    const added = rules.find((rule) => rule.matchValue === UNKNOWN_REFERRER.referrerEmail);

    expect(added).toMatchObject({
      matchType: 'email',
      organisationName: 'A Charity, Properly Named',
      isActive: 1,
    });
    // The whole domain must not have been authorised on the strength of one
    // referral — that would quietly let in everybody who works there.
    expect(rules.some((rule) => rule.matchValue === 'notonthelist.example')).toBe(false);

    // And the next referral from that address is no longer held up.
    const next = await submitReferral(testApp, w, UNKNOWN_REFERRER);
    expect(next.referralStatus).toBe('active');
  });

  it('takes the organisation name from the administrator, not from the referral', async () => {
    const { testApp, token, id } = await pending();

    await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: adminJson(token),
      body: JSON.stringify({
        authoriseReferrer: { organisationName: 'Guildford Borough Council' },
      }),
    });

    const [added] = await db
      .select()
      .from(authorisedReferrers)
      .where(eq(authorisedReferrers.matchValue, UNKNOWN_REFERRER.referrerEmail));

    // The referrer typed 'A Charity Nobody Has Added Yet'. What goes on the
    // list is what the administrator keyed, which is the whole point: the list
    // is the reporting key and free text fills it with near-duplicates.
    expect(added?.organisationName).toBe('Guildford Borough Council');
    expect(added?.organisationName).not.toBe(UNKNOWN_REFERRER.referrerOrganisation);
  });

  it('refuses without an organisation name', async () => {
    const { testApp, token, id } = await pending();

    const response = await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: adminJson(token),
      body: JSON.stringify({ authoriseReferrer: {} }),
    });

    expect(response.status).toBe(400);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).toBe('pending_review');
  });

  it('leaves the referral pending when the address is already on the list', async () => {
    const { testApp, token, id } = await pending();

    await testApp.request('/api/v1/authorised-referrers', {
      method: 'POST',
      headers: adminJson(token),
      body: JSON.stringify({
        matchType: 'email',
        matchValue: UNKNOWN_REFERRER.referrerEmail,
        organisationName: 'Added Earlier By Somebody Else',
      }),
    });

    const response = await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: adminJson(token),
      body: JSON.stringify({ authoriseReferrer: { organisationName: 'A Second Name' } }),
    });

    expect(response.status).toBe(409);

    // Nothing happened: the referral is untouched, so plain accept is the next
    // step, and the existing list entry keeps its name.
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).toBe('pending_review');

    const [existing] = await db
      .select()
      .from(authorisedReferrers)
      .where(eq(authorisedReferrers.matchValue, UNKNOWN_REFERRER.referrerEmail));
    expect(existing?.organisationName).toBe('Added Earlier By Somebody Else');
  });

  it('does not authorise anybody when the referral is only accepted', async () => {
    const { testApp, token, id } = await pending();

    await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: adminJson(token),
      body: JSON.stringify({ comment: 'Just this once' }),
    });

    const rules = await db.select().from(authorisedReferrers);
    expect(rules.some((rule) => rule.matchValue === UNKNOWN_REFERRER.referrerEmail)).toBe(false);
  });
});

describe('reading a referral through', () => {
  function adminJson(token: string): Record<string, string> {
    return { ...authHeaders(token), 'content-type': 'application/json' };
  }

  it('moves an active referral to reviewed, and records who read it', async () => {
    const { testApp, token, world: w } = await world();
    const { id, referralStatus } = await submitReferral(testApp, w);
    expect(referralStatus).toBe('active'); // A recognised address: nobody has read it yet.

    const response = await testApp.request(`/api/v1/referrals/${id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'reviewed' });

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).toBe('reviewed');
    expect(stored?.reviewedByUserId).toEqual(expect.any(String));

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    expect(audit.find((row) => row.action === 'reviewed')?.actorKind).toBe('user');
  });

  it('is the pile still to read: filtering on active excludes what has been read', async () => {
    const { testApp, token, world: w } = await world();
    const first = await submitReferral(testApp, w);
    await submitReferral(testApp, w, { refereeSurname: 'Ashby' });

    await testApp.request(`/api/v1/referrals/${first.id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const unread = await testApp.request('/api/v1/referrals?status=active', {
      headers: authHeaders(token),
    });
    const { referrals: rows }: { referrals: { id: string }[] } = await unread.json();

    expect(rows.map((row) => row.id)).not.toContain(first.id);
    expect(rows).toHaveLength(1);
  });

  it('will not read a referral that has not been decided yet', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, UNKNOWN_REFERRER);

    const response = await testApp.request(`/api/v1/referrals/${id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(409);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).toBe('pending_review');
  });

  it('refuses a second reading, and refuses one on a cancelled referral', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const read = (referralId: string) =>
      testApp.request(`/api/v1/referrals/${referralId}/review`, {
        method: 'POST',
        headers: authHeaders(token),
      });

    expect((await read(id)).status).toBe(200);
    expect((await read(id)).status).toBe(409);

    const other = await submitReferral(testApp, w, { refereeSurname: 'Ashby' });
    await testApp.request(`/api/v1/referrals/${other.id}/cancel`, {
      method: 'POST',
      headers: adminJson(token),
    });
    expect((await read(other.id)).status).toBe(409);
  });

  it('refuses a team lead', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await lead.request(`/api/v1/referrals/${id}/review`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });

    expect(response.status).toBe(403);
  });

  it('changes nothing else: a read referral still holds its place', async () => {
    const { testApp, token, world: w } = await world({ capacity: 1 });
    const { id } = await submitReferral(testApp, w);

    await testApp.request(`/api/v1/referrals/${id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    // The session is still full, and the public list still does not offer it.
    expect((await submitReferral(testApp, w)).status).toBe(409);

    const response = await testApp.request('/api/v1/public/sessions');
    const { sessions: offered }: { sessions: { id: string }[] } = await response.json();
    expect(offered.map((session) => session.id)).not.toContain(w.sessionId);
  });

  it('can still be amended, moved and cancelled once read', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    await testApp.request(`/api/v1/referrals/${id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const amended = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: adminJson(token),
      body: JSON.stringify({ answers: { Other: 'Rang about the time' } }),
    });
    expect(amended.status).toBe(200);

    const cancelled = await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: adminJson(token),
    });
    expect(cancelled.status).toBe(200);
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
      body: JSON.stringify({ answers: { Other: 'anything' } }),
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
      body: JSON.stringify({
        refereeSurname: 'Renamed',
        refereeAddress: '4 Elm Road',
        answers: { Other: 'Renamed, and moved to 4 Elm Road' },
      }),
    });

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    const amended = audit.find((row) => row.action === 'amended');

    expect(amended?.detailJson).toContain('refereeSurname');
    expect(amended?.detailJson).toContain('refereeAddress');
    expect(amended?.detailJson).toContain('answers');
    // The whole point: names of fields, never their contents. It matters more
    // now that the household's own details are correctable — the values passing
    // through here are names and addresses, and this table is not purged.
    expect(amended?.detailJson).not.toContain('Renamed');
    expect(amended?.detailJson).not.toContain('Elm Road');
    expect(amended?.actorKind).toBe('user');
  });

  it("corrects the household's own details", async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        refereeFirstName: 'Alys',
        refereeSurname: 'Wintergreene',
        refereeDateOfBirth: '1985-03-15',
        refereeAddress: '4 Elm Road',
        refereePostcode: 'GU2 7XH',
        refereePhone: '07700 900999',
        // `adults`/`children` are no longer accepted on a PATCH; the same
        // operational household (3 adults, 2 children) expressed as bands.
        teenagers12To17: 0,
        adults18Plus: 3,
        children4To11: 2,
        isDelivery: true,
        needsFuelHelp: true,
      }),
    });

    expect(response.status).toBe(200);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored).toMatchObject({
      refereeFirstName: 'Alys',
      refereeSurname: 'Wintergreene',
      refereeDateOfBirth: '1985-03-15',
      refereeAddress: '4 Elm Road',
      refereePostcode: 'GU2 7XH',
      refereePhone: '07700 900999',
      teenagers12To17: 0,
      adults18Plus: 3,
      children4To11: 2,
      // Derived from the bands above, not sent directly.
      adults: 3,
      children: 2,
      isDelivery: 1,
      needsFuelHelp: 1,
    });
  });

  it('leaves untouched anything the correction did not mention', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    // A one-field correction is a one-field request: the client does not have
    // to restate the referral to fix a postcode.
    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ refereePostcode: 'GU2 7XH' }),
    });
    expect(response.status).toBe(200);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.refereePostcode).toBe('GU2 7XH');
    expect(stored?.refereeSurname).toBe('Wintergreen');
    expect(stored?.refereeAddress).toBe('12 Bramble Cottages');
    expect(stored?.adults).toBe(2);
    expect(stored?.answersJson).toContain('no pork');
  });

  it('removes a phone number when sent an explicit null', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ refereePhone: null }),
    });
    expect(response.status).toBe(200);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.refereePhone).toBeNull();
  });

  it("refuses the referrer's own details", async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    // The email above all: it is what the accept-or-hold decision was made on,
    // so a referral whose address had changed would no longer explain its own
    // status. The body is strict so these are named rather than dropped.
    for (const body of [
      { referrerName: 'Someone Else' },
      { referrerEmail: 'someone@else.example' },
      { referrerPhone: '01483 999999' },
      { referrerOrganisation: 'A Different Council' },
      { status: 'reviewed' },
    ]) {
      const response = await testApp.request(`/api/v1/referrals/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status, `PATCH ${JSON.stringify(body)}`).toBe(400);
    }

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.referrerEmail).toBe('jane@guildford.gov.uk');
  });

  it('refuses a correction that changes nothing', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    // An empty body is far more likely to be a client bug than an intent, and
    // answering 200 to it would report a correction that never happened.
    // `acknowledgeOverCapacity` alone is the same thing: it qualifies a move
    // rather than being one.
    for (const body of [{}, { acknowledgeOverCapacity: true }]) {
      const response = await testApp.request(`/api/v1/referrals/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status, `PATCH ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it('refuses a reason the charity no longer offers', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ reasonId: crypto.randomUUID() }),
    });

    // 422 rather than a foreign-key violation, whose message would carry the
    // bound row — that is, the household.
    expect(response.status).toBe(422);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.reasonId).toBe(w.reasonId);
  });

  it('amends the answers, replacing them outright', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { Other: 'Rang: needs the food left in the porch' } }),
    });
    expect(response.status).toBe(200);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    const answers: Record<string, unknown> = JSON.parse(stored?.answersJson ?? '{}');

    expect(answers.Other).toBe('Rang: needs the food left in the porch');
    // Replaced, not merged: the client holds the form and sends the whole set.
    expect(Object.keys(answers)).toEqual(['Other']);
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
    for (const body of [{ answers: { Other: 'anything' } }, { sessionId: otherSessionId }]) {
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

describe("amending the household's age bands", () => {
  it('recomputes adults and children from the merged household when only one band is patched', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, {
      teenagers12To17: 0,
      adults18Plus: 2,
      children4To11: 3,
    });

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ children4To11: 1 }),
    });
    expect(response.status).toBe(200);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored).toMatchObject({
      teenagers12To17: 0,
      adults18Plus: 2,
      children4To11: 1,
      adults: 2,
      children: 1,
    });
  });

  it('refuses a patch that leaves nobody twelve or over, and writes nothing', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, {
      teenagers12To17: 1,
      adults18Plus: 0,
      children4To11: 2,
    });
    const [before] = await db.select().from(referrals).where(eq(referrals.id, id));

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      // Only the teenager band is sent; merged against the stored
      // `adults18Plus: 0` this leaves the household with nobody 12 or over.
      body: JSON.stringify({ teenagers12To17: 0 }),
    });
    expect(response.status).toBe(422);
    const body: { error: { message: string } } = await response.json();
    expect(body.error.message).toBe('A household must include at least one person aged 12 or over');

    const [after] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(after).toEqual(before);
  });

  it('leaves adults and children untouched when the patch names no band', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, {
      teenagers12To17: 0,
      adults18Plus: 2,
      children4To11: 3,
    });

    const response = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ refereePostcode: 'GU2 7XH' }),
    });
    expect(response.status).toBe(200);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored).toMatchObject({
      teenagers12To17: 0,
      adults18Plus: 2,
      children4To11: 3,
      adults: 2,
      children: 3,
    });
  });

  it('lists the band that was sent in the audit trail, but never the derived adults or children', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, {
      teenagers12To17: 0,
      adults18Plus: 2,
      children4To11: 3,
    });

    await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ children4To11: 1 }),
    });

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    const amended = audit.find((row) => row.action === 'amended');

    expect(amended?.detailJson).toContain('children4To11');
    // Derived, not amended: the field names the client can correct, never the
    // values everything downstream recomputes from them.
    expect(amended?.detailJson).not.toContain('"adults"');
    expect(amended?.detailJson).not.toContain('"children"');
  });

  it('refuses adults or children directly, because they are derived rather than amendable', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    for (const body of [{ adults: 3 }, { children: 1 }, { adults: 3, children: 1 }]) {
      const response = await testApp.request(`/api/v1/referrals/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status, `PATCH ${JSON.stringify(body)}`).toBe(400);
    }

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adults).toBe(2);
    expect(stored?.children).toBe(3);
  });
});

describe('amending age bands against a stale read', () => {
  /**
   * The same wiring `serviceFor` builds in `referrals.routes.ts`, built
   * directly so a test can call `applyAmendment` with a `Referral` object
   * it controls rather than one the service just fetched — which is the
   * only way to make the staleness in the defect this guards against
   * deterministic instead of racing two HTTP requests.
   */
  function directService() {
    const clock = fixedClock(NOW);
    const referrers = createReferrersRepository(db);
    return createReferralsService({
      db,
      clock,
      logger: createLogger('silent'),
      repository: createReferralsRepository(db),
      sessions: createSessionsRepository(db),
      referrers,
      referrersService: createReferrersService({ repository: referrers, clock }),
    });
  }

  async function storedReferral(id: string): Promise<Referral> {
    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    if (row === undefined) throw new Error('expected a referral row');
    return row;
  }

  it('refuses an amendment merged against a stale read of the other band, and leaves nobody-twelve-or-over impossible', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, {
      teenagers12To17: 1,
      adults18Plus: 1,
      children4To11: 2,
    });

    // The row as this (imagined) request read it, before anybody else
    // touched it.
    const stale = await storedReferral(id);

    // A second administrator's amendment lands first, clearing the adult
    // band. On its own this is a perfectly legal write — the household
    // still has its teenager — and it is exactly the change the first
    // request's stale read cannot see.
    const concurrent = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ adults18Plus: 0 }),
    });
    expect(concurrent.status).toBe(200);

    const service = directService();
    let caught: unknown;
    try {
      // Called with the STALE object, patching the other band. Merged
      // against `stale` (which still shows `adults18Plus: 1`), this looks
      // like a household that keeps its teenager and loses nothing — the
      // exact miscalculation the fix in `updateIfBandsUnchanged` exists to
      // stop reaching the database.
      await service.applyAmendment(stale, { teenagers12To17: 0 }, { kind: 'user', userId: null });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConflictError);
    expect(caught).toMatchObject({
      statusCode: 409,
      message:
        'This household was changed while you were amending it. Read the referral again and reapply the change.',
    });

    // The point of the test: re-read the row and check the invariant the
    // guard exists to protect, not just that an error was thrown.
    const after = await storedReferral(id);
    expect(after.teenagers12To17 + after.adults18Plus).toBeGreaterThanOrEqual(1);
    expect(after.adults).toBe(after.teenagers12To17 + after.adults18Plus);
    // And the rejected write never landed: the household still has the
    // teenager the concurrent write left it, band-for-band.
    expect(after).toMatchObject({ teenagers12To17: 1, adults18Plus: 0 });
  });

  it('writes through when nobody else has touched the row, proving the guard is not simply always failing', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w, {
      teenagers12To17: 0,
      adults18Plus: 2,
      children4To11: 1,
    });
    const before = await storedReferral(id);

    const service = directService();
    const updated = await service.applyAmendment(
      before,
      { adults18Plus: 3 },
      { kind: 'user', userId: null },
    );

    expect(updated.adults18Plus).toBe(3);
    expect(updated.adults).toBe(3);

    const after = await storedReferral(id);
    expect(after.adults18Plus).toBe(3);
    expect(after.adults).toBe(3);
  });

  it('takes the unconditional path for a non-band amendment, unaffected by bands changing underneath the stale object', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w, {
      teenagers12To17: 1,
      adults18Plus: 1,
      children4To11: 2,
    });

    // The row as an (imagined) request read it, before anybody else
    // touched the bands.
    const stale = await storedReferral(id);

    // The bands are changed underneath it directly — a household whose
    // shape the stale object no longer describes at all.
    await db
      .update(referrals)
      .set({ teenagers12To17: 0, adults18Plus: 5, adults: 5 })
      .where(eq(referrals.id, id));

    const service = directService();
    // The patch carries no band, so `applyAmendment` must take the
    // unconditional `repository.update` — never `updateIfBandsUnchanged` —
    // and must not be refused merely because `stale`'s bands disagree with
    // what is now stored.
    const updated = await service.applyAmendment(
      stale,
      { refereeAddress: '9 New Road' },
      { kind: 'user', userId: null },
    );

    expect(updated.refereeAddress).toBe('9 New Road');
    // The bands and the derived pair are exactly what the concurrent write
    // above left them — untouched by this amendment.
    expect(updated.teenagers12To17).toBe(0);
    expect(updated.adults18Plus).toBe(5);
    expect(updated.adults).toBe(5);

    const after = await storedReferral(id);
    expect(after).toMatchObject({
      refereeAddress: '9 New Road',
      teenagers12To17: 0,
      adults18Plus: 5,
      adults: 5,
    });
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
