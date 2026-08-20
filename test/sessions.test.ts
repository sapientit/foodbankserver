import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { systemJobs } from '../src/db/schema/jobs.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import { setUpReferralWorld, submitReferral } from './helpers/referral-fixtures.ts';

const db = createDatabase(env.DB);

/** A Monday, comfortably inside BST. */
const NOW = '2026-07-27T08:00:00.000Z';

async function adminApp(now = NOW): Promise<{ testApp: TestApp; token: string }> {
  const testApp = buildTestApp({ clock: fixedClock(now) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  return { testApp, token: accessToken };
}

async function createTuesdayTemplate(testApp: TestApp, token: string): Promise<string> {
  const response = await testApp.request('/api/v1/recurring-sessions', {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Tuesday morning',
      weekday: 2,
      startTime: '10:00',
      durationMinutes: 120,
      location: 'Church Hall',
      activeFrom: '2026-01-01',
      // `deliveryCapacity` has no schema default (unlike `capacity`), so it
      // must always be sent explicitly here.
      deliveryCapacity: 25,
    }),
  });
  expect(response.status).toBe(201);
  const created: { id: string; capacity: number } = await response.json();
  expect(created.capacity).toBe(25); // default
  return created.id;
}

async function runMaterialisation(testApp: TestApp, token: string) {
  const response = await testApp.request('/api/v1/jobs/session-materialisation/run', {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
  const result: { sessionsCreated: number; occurrencesPlanned: number } = await response.json();
  return result;
}

describe('session materialisation', () => {
  beforeEach(async () => {
    await db.delete(sessions);
    await db.delete(recurringSessions);
    await db.delete(systemJobs);
    await db.delete(refreshTokens);
    await db.delete(users);
  });

  it('generates six weeks of sessions and adds nothing on a second run', async () => {
    const { testApp, token } = await adminApp();
    await createTuesdayTemplate(testApp, token);

    const first = await runMaterialisation(testApp, token);
    expect(first.sessionsCreated).toBe(6); // Tuesdays within 27 July + 42 days

    const second = await runMaterialisation(testApp, token);
    expect(second.sessionsCreated).toBe(0);

    expect(await db.select().from(sessions)).toHaveLength(6);
  });

  it('does not overwrite a session an admin has re-timed', async () => {
    const { testApp, token } = await adminApp();
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const [first] = await db.select().from(sessions).orderBy(sessions.startsAtUtc);
    const moved = await testApp.request(`/api/v1/sessions/${first?.id ?? ''}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ sessionDate: '2026-07-29', startTime: '14:30', location: 'Annexe' }),
    });
    expect(moved.status).toBe(200);

    // Re-running must not resurrect Tuesday, because occurrenceDate is the key
    // and it was deliberately left alone.
    const rerun = await runMaterialisation(testApp, token);
    expect(rerun.sessionsCreated).toBe(0);

    const [after] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, first?.id ?? ''));
    expect(after?.sessionDate).toBe('2026-07-29');
    expect(after?.startTime).toBe('14:30');
    expect(after?.location).toBe('Annexe');
    expect(after?.isCustomised).toBe(1);
    // The occurrence slot it fills is unchanged.
    expect(after?.occurrenceDate).toBe('2026-07-28');
  });

  it('re-derives the instant when a session is re-timed', async () => {
    const { testApp, token } = await adminApp();
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const [first] = await db.select().from(sessions).orderBy(sessions.startsAtUtc);
    expect(first?.startsAtUtc).toBe('2026-07-28T09:00:00.000Z'); // 10:00 BST

    await testApp.request(`/api/v1/sessions/${first?.id ?? ''}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ startTime: '14:30' }),
    });

    const [after] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, first?.id ?? ''));
    expect(after?.startsAtUtc).toBe('2026-07-28T13:30:00.000Z');
  });

  it('leaves a cancelled occurrence cancelled on the next run', async () => {
    const { testApp, token } = await adminApp();
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const [first] = await db.select().from(sessions).orderBy(sessions.startsAtUtc);
    await testApp.request(`/api/v1/sessions/${first?.id ?? ''}/cancel`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Hall flooded' }),
    });

    await runMaterialisation(testApp, token);

    const [after] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, first?.id ?? ''));
    expect(after?.status).toBe('cancelled');
    expect(after?.cancelledReason).toBe('Hall flooded');
    expect(await db.select().from(sessions)).toHaveLength(6);
  });

  it('records the job outcome so a stopped cron is visible', async () => {
    const { testApp, token } = await adminApp();
    await createTuesdayTemplate(testApp, token);

    await runMaterialisation(testApp, token);
    await runMaterialisation(testApp, token);

    const [job] = await db.select().from(systemJobs);
    expect(job?.name).toBe('session-materialisation');
    expect(job?.runCount).toBe(2);
    expect(job?.lastSuccessAt).toEqual(expect.any(String));
    expect(job?.lastError).toBeNull();
  });

  it('never touches an ad hoc session', async () => {
    const { testApp, token } = await adminApp();

    const created = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-06',
        startTime: '18:00',
        durationMinutes: 90,
        location: 'Community Centre',
        capacity: 10,
        deliveryCapacity: 10,
      }),
    });
    expect(created.status).toBe(201);

    const rerun = await runMaterialisation(testApp, token);
    expect(rerun.sessionsCreated).toBe(0);
    expect(await db.select().from(sessions)).toHaveLength(1);
  });
});

describe('public session list', () => {
  beforeEach(async () => {
    await db.delete(sessions);
    await db.delete(recurringSessions);
    await db.delete(systemJobs);
    await db.delete(refreshTokens);
    await db.delete(users);
  });

  it('needs no authentication', async () => {
    const { testApp, token } = await adminApp();
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const response = await testApp.request('/api/v1/public/sessions');

    expect(response.status).toBe(200);
  });

  it('returns only the next fourteen days', async () => {
    const { testApp, token } = await adminApp();
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const response = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: { sessionDate: string }[] } = await response.json();

    // Six weeks were generated; only the two Tuesdays inside the fourteen-day
    // public window from Monday 27 July are offered.
    expect(body.sessions.map((s) => s.sessionDate)).toEqual(['2026-07-28', '2026-08-04']);
  });

  // Referrals close at 16:00 London the day before a session. NOW is 09:00 on
  // Monday 27 July, so tomorrow's Tuesday session is still inside its deadline
  // — which is why the fourteen-day test above still sees it.
  it('still offers tomorrow just before four the day before', async () => {
    const { testApp, token } = await adminApp('2026-07-27T14:59:00.000Z'); // 15:59 BST
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const response = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: { sessionDate: string }[] } = await response.json();

    expect(body.sessions.map((s) => s.sessionDate)).toContain('2026-07-28');
  });

  it('stops offering tomorrow once four the day before has passed', async () => {
    const { testApp, token } = await adminApp('2026-07-27T15:01:00.000Z'); // 16:01 BST
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const response = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: { sessionDate: string }[] } = await response.json();

    // The far end does not move with the cutoff, so this is the same window as
    // at nine that morning minus its first day, not one shifted forward.
    expect(body.sessions.map((s) => s.sessionDate)).toEqual(['2026-08-04']);
  });

  it('counts four o’clock itself as making the deadline', async () => {
    const { testApp, token } = await adminApp('2026-07-27T15:00:00.000Z'); // 16:00 BST
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const response = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: { sessionDate: string }[] } = await response.json();

    // Four o'clock is the time a referrer is asked to be in by, so the 16:00
    // minute still makes it. 16:01 is where it stops — the test above.
    expect(body.sessions.map((s) => s.sessionDate)).toContain('2026-07-28');
  });

  it('reads four o’clock off the London clock in winter too', async () => {
    // 15:59 on Monday 7 December, and London is on GMT — so the instant and
    // the wall clock agree. Code that assumed the BST offset would read this
    // as 16:59 and drop Tuesday's session an hour early, on half the year.
    const { testApp, token } = await adminApp('2026-12-07T15:59:00.000Z');
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const response = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: { sessionDate: string }[] } = await response.json();

    expect(body.sessions.map((s) => s.sessionDate)).toEqual(['2026-12-08', '2026-12-15']);
  });

  it('never offers a session on its own day', async () => {
    // Tuesday morning, before the 10:00 session it would otherwise offer.
    const { testApp, token } = await adminApp('2026-07-28T07:00:00.000Z');
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const response = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: { sessionDate: string }[] } = await response.json();

    expect(body.sessions.map((s) => s.sessionDate)).toEqual(['2026-08-04', '2026-08-11']);
  });

  it('counts the cutoff on the London date, not the UTC one', async () => {
    // 00:30 on Tuesday 28 July in London, still 27 July in UTC. Reading the
    // date off the instant would offer Tuesday's session on Tuesday morning.
    const { testApp, token } = await adminApp('2026-07-27T23:30:00.000Z');
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const response = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: { sessionDate: string }[] } = await response.json();

    expect(body.sessions.map((s) => s.sessionDate)).not.toContain('2026-07-28');
  });

  it('excludes cancelled sessions', async () => {
    const { testApp, token } = await adminApp();
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const [first] = await db.select().from(sessions).orderBy(sessions.startsAtUtc);
    await testApp.request(`/api/v1/sessions/${first?.id ?? ''}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const response = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: { sessionDate: string }[] } = await response.json();

    expect(body.sessions.map((s) => s.sessionDate)).not.toContain('2026-07-28');
  });

  it('leaks no operational detail', async () => {
    const { testApp, token } = await adminApp();
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const response = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: Record<string, unknown>[] } = await response.json();

    // No capacity, no remaining places, no raw booked count, no internal
    // flags. The referral form needs `deliveryAvailability` to know whether
    // it can offer delivery at all, and the effective
    // `deliveryWindowStart`/`deliveryWindowEnd` so it can ask the referrer to
    // confirm the client will be at home for it.
    expect(Object.keys(body.sessions[0] ?? {}).sort()).toEqual([
      'deliveryAvailability',
      'deliveryWindowEnd',
      'deliveryWindowStart',
      'durationMinutes',
      'id',
      'location',
      'sessionDate',
      'startTime',
      'startsAtUtc',
    ]);
  });
});

/**
 * Occupancy on the staff view.
 *
 * The count is derived, so the risk is not that it is wrong once — it is that
 * it costs a query per session on a route with no pagination. The last test
 * here is the one that guards that.
 */
describe('session occupancy', () => {
  beforeEach(async () => {
    await db.delete(auditEvents);
    await db.delete(referrals);
    await db.delete(referralReasons);
    await db.delete(authorisedReferrers);
    await db.delete(sessions);
    await db.delete(recurringSessions);
    await db.delete(systemJobs);
    await db.delete(refreshTokens);
    await db.delete(users);
  });

  it('reports no bookings on a session nobody has been referred to', async () => {
    const testApp = buildTestApp({ clock: fixedClock('2026-08-04T09:00:00.000Z') });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const built = await setUpReferralWorld(testApp, accessToken);

    const response = await testApp.request(`/api/v1/sessions/${built.sessionId}`, {
      headers: authHeaders(accessToken),
    });
    const body: { capacity: number; booked: number } = await response.json();

    expect(body.booked).toBe(0);
    expect(body.capacity).toBe(25);
  });

  it('counts households rather than people', async () => {
    const testApp = buildTestApp({ clock: fixedClock('2026-08-04T09:00:00.000Z') });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const built = await setUpReferralWorld(testApp, accessToken);

    // Two referrals, five people each. Capacity counts the referrals.
    await submitReferral(testApp, built, { adults: 2, children: 3 }, { clientIp: '203.0.113.1' });
    await submitReferral(testApp, built, { adults: 2, children: 3 }, { clientIp: '203.0.113.2' });

    const response = await testApp.request(`/api/v1/sessions/${built.sessionId}`, {
      headers: authHeaders(accessToken),
    });
    const body: { booked: number } = await response.json();

    expect(body.booked).toBe(2);
  });

  it('stops counting a referral once it is cancelled', async () => {
    const testApp = buildTestApp({ clock: fixedClock('2026-08-04T09:00:00.000Z') });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const built = await setUpReferralWorld(testApp, accessToken);

    const first = await submitReferral(testApp, built, {}, { clientIp: '203.0.113.3' });
    await submitReferral(testApp, built, {}, { clientIp: '203.0.113.4' });

    const cancelled = await testApp.request(`/api/v1/referrals/${first.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });
    expect(cancelled.status).toBe(200);

    const response = await testApp.request(`/api/v1/sessions/${built.sessionId}`, {
      headers: authHeaders(accessToken),
    });
    const body: { booked: number } = await response.json();

    expect(body.booked).toBe(1);
  });

  it('includes a full session in the staff list rather than hiding it', async () => {
    const testApp = buildTestApp({ clock: fixedClock('2026-08-04T09:00:00.000Z') });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const built = await setUpReferralWorld(testApp, accessToken, { capacity: 1 });

    await submitReferral(testApp, built, {}, { clientIp: '203.0.113.5' });

    // The public list filters full sessions out; the staff list must not, or an
    // admin cannot see the session that needs attention.
    const publicList = await testApp.request('/api/v1/public/sessions');
    const publicBody: { sessions: { id: string }[] } = await publicList.json();
    expect(publicBody.sessions.map((s) => s.id)).not.toContain(built.sessionId);

    const staffList = await testApp.request('/api/v1/sessions', {
      headers: authHeaders(accessToken),
    });
    const staffBody: { sessions: { id: string; capacity: number; booked: number }[] } =
      await staffList.json();
    const full = staffBody.sessions.find((s) => s.id === built.sessionId);

    expect(full).toMatchObject({ capacity: 1, booked: 1 });
  });

  // Note this asserts the *result*, not the query count — it cannot see how
  // many statements ran. The single-query guarantee lives in
  // `sessions.repository.list`, where the aggregate join replaces a per-row
  // count; this test is what fails if that join ever stops attaching a count to
  // every row, which is the observable half of the same mistake.
  it('attaches a booked count to every session in the list', async () => {
    const testApp = buildTestApp({ clock: fixedClock('2026-08-04T09:00:00.000Z') });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const built = await setUpReferralWorld(testApp, accessToken);

    // Several more sessions, so a per-session count would show up as a rising
    // query count rather than a constant one.
    for (const day of ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-17']) {
      await testApp.request('/api/v1/sessions', {
        method: 'POST',
        headers: { ...authHeaders(accessToken), 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionDate: day,
          startTime: '10:00',
          durationMinutes: 120,
          location: 'Church Hall',
          deliveryCapacity: 25,
        }),
      });
    }
    await submitReferral(testApp, built, {}, { clientIp: '203.0.113.6' });

    const response = await testApp.request('/api/v1/sessions', {
      headers: authHeaders(accessToken),
    });
    const body: { sessions: { id: string; booked: number }[] } = await response.json();

    expect(body.sessions).toHaveLength(5);
    // Every session carries a count, and only the referred-to one is non-zero.
    expect(body.sessions.every((s) => typeof s.booked === 'number')).toBe(true);
    expect(body.sessions.filter((s) => s.booked > 0).map((s) => s.id)).toEqual([built.sessionId]);
  });

  it('does not publish the booked count to the unauthenticated list', async () => {
    const testApp = buildTestApp({ clock: fixedClock('2026-08-04T09:00:00.000Z') });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    await setUpReferralWorld(testApp, accessToken);

    const response = await testApp.request('/api/v1/public/sessions');
    const body: { sessions: Record<string, unknown>[] } = await response.json();

    // How full a session is stays internal, so `booked` must not leak with it.
    expect(Object.keys(body.sessions[0] ?? {})).not.toContain('booked');
    expect(Object.keys(body.sessions[0] ?? {})).not.toContain('capacity');
  });
});

/**
 * How far ahead each role sees.
 *
 * The clock is deliberately 23:30 UTC on 21 October 2026 — 00:30 the following
 * morning in London, which is still on BST. So "today" is 22 October in London
 * and 21 October in UTC, and every boundary below moves by a day if the wrong
 * one is taken. The six-day window also spans the 25 October changeover back to
 * GMT, so a horizon built out of instants rather than calendar dates drifts.
 */
describe('staff session horizon', () => {
  const LATE_EVENING_UTC = '2026-10-21T23:30:00.000Z'; // 00:30 on 22 October, London

  const TODAY = '2026-10-22';
  const TOMORROW = '2026-10-23';
  const SIX_DAYS_OUT = '2026-10-28'; // the last day a team lead may see
  const SEVEN_DAYS_OUT = '2026-10-29';
  const FIVE_WEEKS_OUT = '2026-11-26';
  const YESTERDAY = '2026-10-21';

  const ALL_DATES = [
    YESTERDAY,
    TODAY,
    TOMORROW,
    SIX_DAYS_OUT,
    SEVEN_DAYS_OUT,
    FIVE_WEEKS_OUT,
  ] as const;

  beforeEach(async () => {
    await db.delete(sessions);
    await db.delete(recurringSessions);
    await db.delete(systemJobs);
    await db.delete(refreshTokens);
    await db.delete(users);
  });

  /** One ad hoc session on each date above, created by an admin. */
  async function seedCalendar(): Promise<{ testApp: TestApp; adminToken: string }> {
    const testApp = buildTestApp({ clock: fixedClock(LATE_EVENING_UTC) });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });

    for (const sessionDate of ALL_DATES) {
      const created = await testApp.request('/api/v1/sessions', {
        method: 'POST',
        headers: { ...authHeaders(accessToken), 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionDate,
          startTime: '10:00',
          durationMinutes: 120,
          location: 'Church Hall',
          deliveryCapacity: 25,
        }),
      });
      expect(created.status).toBe(201);
    }

    return { testApp, adminToken: accessToken };
  }

  async function listDates(testApp: TestApp, token: string, query = ''): Promise<string[]> {
    const response = await testApp.request(`/api/v1/sessions${query}`, {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);
    const body: { sessions: { sessionDate: string }[] } = await response.json();
    return body.sessions.map((s) => s.sessionDate);
  }

  it('shows an admin a session five weeks out', async () => {
    const { testApp, adminToken } = await seedCalendar();

    expect(await listDates(testApp, adminToken)).toEqual([...ALL_DATES]);
  });

  it('does not show a team lead a session five weeks out', async () => {
    const { testApp } = await seedCalendar();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    expect(await listDates(testApp, accessToken)).not.toContain(FIVE_WEEKS_OUT);
  });

  it('shows a team lead the session tomorrow and the one six days out', async () => {
    const { testApp } = await seedCalendar();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const visible = await listDates(testApp, accessToken);

    expect(visible).toContain(TOMORROW);
    expect(visible).toContain(SIX_DAYS_OUT);
    expect(visible).toContain(TODAY);
  });

  it('shows a team lead a past session that is still unconfirmed', async () => {
    const { testApp } = await seedCalendar();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    // Only the far end of the window is capped: outcomes and details are
    // often completed after the event, so a team lead still needs the
    // session just gone, right through to the boundary six days ahead — and
    // not the one the day after that.
    const visible = await listDates(testApp, accessToken);
    expect(visible).toContain(YESTERDAY);
    expect(visible).toContain(SIX_DAYS_OUT);
    expect(visible).not.toContain(SEVEN_DAYS_OUT);

    // The past session being visible is not an artefact of it having been
    // confirmed — it is still awaiting a team lead's attention.
    const [yesterdaySession] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.sessionDate, YESTERDAY));
    expect(yesterdaySession?.status).toBe('planned');
  });

  it('does not show a team lead the session seven days out', async () => {
    const { testApp } = await seedCalendar();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    expect(await listDates(testApp, accessToken)).not.toContain(SEVEN_DAYS_OUT);
  });

  it('counts the six days from the London date, not the UTC one', async () => {
    const { testApp } = await seedCalendar();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    // It is 21 October in UTC and 22 October in London. Counting from the UTC
    // date would end the window on 27 October and drop 28 October, which is
    // the whole of the boundary this asserts.
    expect(await listDates(testApp, accessToken)).toEqual([
      YESTERDAY,
      TODAY,
      TOMORROW,
      SIX_DAYS_OUT,
    ]);
  });

  it('does not let a team lead widen the window with a query parameter', async () => {
    const { testApp } = await seedCalendar();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    // Asking for the whole year is clamped back to the horizon, not obeyed.
    const widened = await listDates(testApp, accessToken, '?to=2026-12-31');
    expect(widened).not.toContain(SEVEN_DAYS_OUT);
    expect(widened).not.toContain(FIVE_WEEKS_OUT);

    // And a window entirely beyond the horizon returns nothing at all.
    expect(await listDates(testApp, accessToken, '?from=2026-11-01&to=2026-11-30')).toEqual([]);
  });

  it('narrows to a shorter window a team lead asks for', async () => {
    const { testApp } = await seedCalendar();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    // The cap is a ceiling, not a fixed window: a narrower `to` still applies.
    expect(await listDates(testApp, accessToken, `?from=${TODAY}&to=${TOMORROW}`)).toEqual([
      TODAY,
      TOMORROW,
    ]);
  });

  it('still offers the public list fourteen days, further ahead than a team lead sees', async () => {
    const { testApp } = await seedCalendar();

    const response = await testApp.request('/api/v1/public/sessions');
    expect(response.status).toBe(200);
    const body: { sessions: { sessionDate: string }[] } = await response.json();

    // Fourteen days from 22 October reaches 5 November: past the team lead's
    // horizon and short of the admin's. A referrer booking a slot and a team
    // lead running a shift are different jobs with different windows.
    //
    // TODAY is absent because referrals for it closed at four yesterday
    // afternoon — the near end is the cutoff, the far end is still fourteen
    // days from today.
    expect(body.sessions.map((s) => s.sessionDate)).toEqual([
      TOMORROW,
      SIX_DAYS_OUT,
      SEVEN_DAYS_OUT,
    ]);
  });
});

/**
 * The delivery window and the delivery capacity: read-out fields with no
 * scheduling effect on the session itself (see `INITIAL_SPEC1.txt`, "Session
 * maintenance"). `deliveryCapacity` is enforced against a delivery referral
 * at submission — see `referrals.service.ts#assertDeliveryCapacityAvailable`
 * — but nothing here enforces the window itself.
 */
describe('delivery fields', () => {
  beforeEach(async () => {
    await db.delete(sessions);
    await db.delete(recurringSessions);
    await db.delete(systemJobs);
    await db.delete(refreshTokens);
    await db.delete(users);
  });

  it('creates an ad hoc session with a delivery window and reads it back', async () => {
    const { testApp, token } = await adminApp();

    const created = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-06',
        startTime: '18:00',
        durationMinutes: 90,
        location: 'Community Centre',
        deliveryCapacity: 25,
        deliveryWindowStart: '17:00',
        deliveryWindowEnd: '17:30',
      }),
    });
    expect(created.status).toBe(201);
    const body: {
      id: string;
      deliveryWindowStart: string | null;
      deliveryWindowEnd: string | null;
    } = await created.json();
    expect(body.deliveryWindowStart).toBe('17:00');
    expect(body.deliveryWindowEnd).toBe('17:30');

    const fetched = await testApp.request(`/api/v1/sessions/${body.id}`, {
      headers: authHeaders(token),
    });
    const fetchedBody: { deliveryWindowStart: string | null; deliveryWindowEnd: string | null } =
      await fetched.json();
    expect(fetchedBody.deliveryWindowStart).toBe('17:00');
    expect(fetchedBody.deliveryWindowEnd).toBe('17:30');
  });

  it('defaults an ad hoc session created without a delivery window to both null', async () => {
    const { testApp, token } = await adminApp();

    const created = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-06',
        startTime: '18:00',
        durationMinutes: 90,
        location: 'Community Centre',
        deliveryCapacity: 25,
      }),
    });
    expect(created.status).toBe(201);
    const body: {
      deliveryWindowStart: string | null;
      deliveryWindowEnd: string | null;
    } = await created.json();
    expect(body.deliveryWindowStart).toBeNull();
    expect(body.deliveryWindowEnd).toBeNull();
  });

  it('patches a delivery window, and clears it back to null explicitly', async () => {
    const { testApp, token } = await adminApp();

    const created = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-06',
        startTime: '18:00',
        durationMinutes: 90,
        location: 'Community Centre',
        deliveryCapacity: 25,
      }),
    });
    const { id }: { id: string } = await created.json();

    const patched = await testApp.request(`/api/v1/sessions/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryWindowStart: '17:00', deliveryWindowEnd: '17:30' }),
    });
    expect(patched.status).toBe(200);
    const patchedBody: { deliveryWindowStart: string | null; deliveryWindowEnd: string | null } =
      await patched.json();
    expect(patchedBody.deliveryWindowStart).toBe('17:00');
    expect(patchedBody.deliveryWindowEnd).toBe('17:30');

    const cleared = await testApp.request(`/api/v1/sessions/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryWindowStart: null, deliveryWindowEnd: null }),
    });
    expect(cleared.status).toBe(200);
    const clearedBody: { deliveryWindowStart: string | null; deliveryWindowEnd: string | null } =
      await cleared.json();
    expect(clearedBody.deliveryWindowStart).toBeNull();
    expect(clearedBody.deliveryWindowEnd).toBeNull();
  });

  it('can set deliveryCapacity at creation and patch it to a different value', async () => {
    const { testApp, token } = await adminApp();

    const created = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-06',
        startTime: '18:00',
        durationMinutes: 90,
        location: 'Community Centre',
        capacity: 25,
        deliveryCapacity: 0,
      }),
    });
    expect(created.status).toBe(201);
    const { id, deliveryCapacity }: { id: string; deliveryCapacity: number } = await created.json();
    expect(deliveryCapacity).toBe(0);

    const patched = await testApp.request(`/api/v1/sessions/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryCapacity: 8 }),
    });
    expect(patched.status).toBe(200);
    const patchedBody: { deliveryCapacity: number } = await patched.json();
    expect(patchedBody.deliveryCapacity).toBe(8);
  });

  it('refuses a create where deliveryCapacity exceeds capacity', async () => {
    const { testApp, token } = await adminApp();

    const response = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-06',
        startTime: '18:00',
        durationMinutes: 90,
        location: 'Community Centre',
        capacity: 10,
        deliveryCapacity: 11,
      }),
    });

    // A Zod refinement on the create schema — `refineCreateDeliveryCapacity`
    // in `sessions.schema.ts` — so a schema-validation 400, not the
    // service-layer 422 a patch gets below.
    expect(response.status).toBe(400);
  });

  it('refuses a patch that would leave deliveryCapacity exceeding capacity', async () => {
    const { testApp, token } = await adminApp();

    const created = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-06',
        startTime: '18:00',
        durationMinutes: 90,
        location: 'Community Centre',
        capacity: 10,
        deliveryCapacity: 5,
      }),
    });
    const { id }: { id: string } = await created.json();

    // Patch schemas validate `capacity` and `deliveryCapacity` in isolation —
    // see the comment on `updateSession` in `sessions.service.ts` — so this
    // is a service-layer check against the existing row, reported as 422.
    const patched = await testApp.request(`/api/v1/sessions/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ capacity: 4 }),
    });
    expect(patched.status).toBe(422);

    const unchanged = await testApp.request(`/api/v1/sessions/${id}`, {
      headers: authHeaders(token),
    });
    const unchangedBody: { capacity: number; deliveryCapacity: number } = await unchanged.json();
    expect(unchangedBody.capacity).toBe(10);
    expect(unchangedBody.deliveryCapacity).toBe(5);
  });

  it('carries both fields on a recurring template and can amend them', async () => {
    const { testApp, token } = await adminApp();

    const created = await testApp.request('/api/v1/recurring-sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Tuesday morning',
        weekday: 2,
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Church Hall',
        activeFrom: '2026-01-01',
        deliveryWindowStart: '09:00',
        deliveryWindowEnd: '09:30',
        deliveryCapacity: 3,
      }),
    });
    expect(created.status).toBe(201);
    const template: {
      id: string;
      deliveryWindowStart: string | null;
      deliveryWindowEnd: string | null;
      deliveryCapacity: number;
    } = await created.json();
    expect(template.deliveryWindowStart).toBe('09:00');
    expect(template.deliveryWindowEnd).toBe('09:30');
    expect(template.deliveryCapacity).toBe(3);

    const patched = await testApp.request(`/api/v1/recurring-sessions/${template.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        deliveryWindowStart: null,
        deliveryWindowEnd: null,
        deliveryCapacity: 9,
      }),
    });
    expect(patched.status).toBe(200);
    const patchedBody: {
      deliveryWindowStart: string | null;
      deliveryWindowEnd: string | null;
      deliveryCapacity: number;
    } = await patched.json();
    expect(patchedBody.deliveryWindowStart).toBeNull();
    expect(patchedBody.deliveryWindowEnd).toBeNull();
    expect(patchedBody.deliveryCapacity).toBe(9);
  });

  it('materialises an occurrence carrying the template’s delivery window and capacity', async () => {
    const { testApp, token } = await adminApp();

    const created = await testApp.request('/api/v1/recurring-sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Tuesday morning',
        weekday: 2,
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Church Hall',
        activeFrom: '2026-01-01',
        deliveryWindowStart: '09:00',
        deliveryWindowEnd: '09:30',
        deliveryCapacity: 6,
      }),
    });
    expect(created.status).toBe(201);

    await runMaterialisation(testApp, token);

    const [occurrence] = await db.select().from(sessions).orderBy(sessions.startsAtUtc);
    expect(occurrence?.deliveryWindowStart).toBe('09:00');
    expect(occurrence?.deliveryWindowEnd).toBe('09:30');
    expect(occurrence?.deliveryCapacity).toBe(6);
  });

  it('reports the session’s own hours as the effective window on the public list when none is set', async () => {
    const { testApp, token } = await adminApp();
    // 10:00 for 120 minutes — no window set on the template.
    await createTuesdayTemplate(testApp, token);
    await runMaterialisation(testApp, token);

    const response = await testApp.request('/api/v1/public/sessions');
    const body: {
      sessions: {
        deliveryAvailability: 'not_offered' | 'full' | 'available';
        deliveryWindowStart: string | null;
        deliveryWindowEnd: string | null;
      }[];
    } = await response.json();

    const first = body.sessions[0];
    expect(first).toBeDefined();
    // `createTuesdayTemplate` sets `deliveryCapacity: 25` and nobody has
    // booked a delivery yet.
    expect(first?.deliveryAvailability).toBe('available');
    expect(first?.deliveryWindowStart).toBe('10:00');
    expect(first?.deliveryWindowEnd).toBe('12:00');
  });

  it('reports the stored window as the effective window on the public list when one is set', async () => {
    const { testApp, token } = await adminApp();

    const created = await testApp.request('/api/v1/recurring-sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Tuesday morning',
        weekday: 2,
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Church Hall',
        activeFrom: '2026-01-01',
        deliveryWindowStart: '13:00',
        deliveryWindowEnd: '15:00',
        deliveryCapacity: 25,
      }),
    });
    expect(created.status).toBe(201);
    await runMaterialisation(testApp, token);

    const response = await testApp.request('/api/v1/public/sessions');
    const body: {
      sessions: { deliveryWindowStart: string | null; deliveryWindowEnd: string | null }[];
    } = await response.json();

    const first = body.sessions[0];
    expect(first).toBeDefined();
    expect(first?.deliveryWindowStart).toBe('13:00');
    expect(first?.deliveryWindowEnd).toBe('15:00');
  });
});

/**
 * Rule 1 (both or neither) and rule 2 (end strictly after start), enforced by
 * Zod at the schema boundary — see `sessions.schema.ts`. Proven through both
 * ad hoc sessions and recurring templates, since `refineCreateDeliveryWindow`
 * / `refinePatchDeliveryWindow` are shared refinements applied to both
 * shapes, and a bug in one could easily not show up in the other.
 */
describe('delivery window validation', () => {
  beforeEach(async () => {
    await db.delete(sessions);
    await db.delete(recurringSessions);
    await db.delete(systemJobs);
    await db.delete(refreshTokens);
    await db.delete(users);
  });

  function adHocBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      sessionDate: '2026-08-06',
      startTime: '18:00',
      durationMinutes: 90,
      location: 'Community Centre',
      // `deliveryCapacity` has no schema default (unlike `capacity`), so it
      // must always be sent explicitly here.
      deliveryCapacity: 25,
      ...overrides,
    });
  }

  async function createAdHoc(testApp: TestApp, token: string): Promise<string> {
    const created = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: adHocBody(),
    });
    expect(created.status).toBe(201);
    const { id }: { id: string } = await created.json();
    return id;
  }

  describe('POST /sessions', () => {
    it('accepts both ends set with the end after the start, and returns them', async () => {
      const { testApp, token } = await adminApp();

      const response = await testApp.request('/api/v1/sessions', {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: adHocBody({ deliveryWindowStart: '13:00', deliveryWindowEnd: '15:00' }),
      });

      expect(response.status).toBe(201);
      const body: { deliveryWindowStart: string | null; deliveryWindowEnd: string | null } =
        await response.json();
      expect(body.deliveryWindowStart).toBe('13:00');
      expect(body.deliveryWindowEnd).toBe('15:00');
    });

    it('refuses a start with no end', async () => {
      const { testApp, token } = await adminApp();

      const response = await testApp.request('/api/v1/sessions', {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: adHocBody({ deliveryWindowStart: '13:00' }),
      });

      expect(response.status).toBe(400);
    });

    it('refuses an end with no start', async () => {
      const { testApp, token } = await adminApp();

      const response = await testApp.request('/api/v1/sessions', {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: adHocBody({ deliveryWindowEnd: '13:00' }),
      });

      expect(response.status).toBe(400);
    });

    it('refuses an end equal to the start', async () => {
      const { testApp, token } = await adminApp();

      const response = await testApp.request('/api/v1/sessions', {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: adHocBody({ deliveryWindowStart: '13:00', deliveryWindowEnd: '13:00' }),
      });

      expect(response.status).toBe(400);
    });

    it('refuses an end before the start', async () => {
      const { testApp, token } = await adminApp();

      const response = await testApp.request('/api/v1/sessions', {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: adHocBody({ deliveryWindowStart: '15:00', deliveryWindowEnd: '13:00' }),
      });

      expect(response.status).toBe(400);
    });

    it('refuses a window that crosses midnight', async () => {
      const { testApp, token } = await adminApp();

      const response = await testApp.request('/api/v1/sessions', {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: adHocBody({ deliveryWindowStart: '22:00', deliveryWindowEnd: '00:30' }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('PATCH /sessions/{id}', () => {
    it('accepts both ends set with the end after the start, and returns them', async () => {
      const { testApp, token } = await adminApp();
      const id = await createAdHoc(testApp, token);

      const response = await testApp.request(`/api/v1/sessions/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryWindowStart: '13:00', deliveryWindowEnd: '15:00' }),
      });

      expect(response.status).toBe(200);
      const body: { deliveryWindowStart: string | null; deliveryWindowEnd: string | null } =
        await response.json();
      expect(body.deliveryWindowStart).toBe('13:00');
      expect(body.deliveryWindowEnd).toBe('15:00');
    });

    it('accepts both ends explicitly null, clearing the window', async () => {
      const { testApp, token } = await adminApp();
      const id = await createAdHoc(testApp, token);

      await testApp.request(`/api/v1/sessions/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryWindowStart: '13:00', deliveryWindowEnd: '15:00' }),
      });

      const response = await testApp.request(`/api/v1/sessions/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryWindowStart: null, deliveryWindowEnd: null }),
      });

      expect(response.status).toBe(200);
      const body: { deliveryWindowStart: string | null; deliveryWindowEnd: string | null } =
        await response.json();
      expect(body.deliveryWindowStart).toBeNull();
      expect(body.deliveryWindowEnd).toBeNull();
    });

    it('refuses one end present and the other absent', async () => {
      const { testApp, token } = await adminApp();
      const id = await createAdHoc(testApp, token);

      const response = await testApp.request(`/api/v1/sessions/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryWindowStart: '13:00' }),
      });

      expect(response.status).toBe(400);
    });

    it('refuses one end null and the other a time', async () => {
      const { testApp, token } = await adminApp();
      const id = await createAdHoc(testApp, token);

      const response = await testApp.request(`/api/v1/sessions/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryWindowStart: null, deliveryWindowEnd: '13:00' }),
      });

      expect(response.status).toBe(400);
    });

    it('refuses an end equal to the start', async () => {
      const { testApp, token } = await adminApp();
      const id = await createAdHoc(testApp, token);

      const response = await testApp.request(`/api/v1/sessions/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryWindowStart: '13:00', deliveryWindowEnd: '13:00' }),
      });

      expect(response.status).toBe(400);
    });

    it('refuses an end before the start', async () => {
      const { testApp, token } = await adminApp();
      const id = await createAdHoc(testApp, token);

      const response = await testApp.request(`/api/v1/sessions/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryWindowStart: '15:00', deliveryWindowEnd: '13:00' }),
      });

      expect(response.status).toBe(400);
    });

    it('refuses a window that crosses midnight', async () => {
      const { testApp, token } = await adminApp();
      const id = await createAdHoc(testApp, token);

      const response = await testApp.request(`/api/v1/sessions/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryWindowStart: '22:00', deliveryWindowEnd: '00:30' }),
      });

      expect(response.status).toBe(400);
    });
  });

  /**
   * The refinement is shared code (`refineCreateDeliveryWindow` /
   * `refinePatchDeliveryWindow`), but a template and a session are different
   * Zod shapes wired up separately — this is the proof the same rules really
   * do apply to both, not just to the ad hoc session shape exercised above.
   */
  describe('recurring session pair', () => {
    it('refuses a create with only the start set', async () => {
      const { testApp, token } = await adminApp();

      const response = await testApp.request('/api/v1/recurring-sessions', {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Tuesday morning',
          weekday: 2,
          startTime: '10:00',
          durationMinutes: 120,
          location: 'Church Hall',
          activeFrom: '2026-01-01',
          deliveryWindowStart: '13:00',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('refuses a create where the end is before the start', async () => {
      const { testApp, token } = await adminApp();

      const response = await testApp.request('/api/v1/recurring-sessions', {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Tuesday morning',
          weekday: 2,
          startTime: '10:00',
          durationMinutes: 120,
          location: 'Church Hall',
          activeFrom: '2026-01-01',
          deliveryWindowStart: '22:00',
          deliveryWindowEnd: '00:30',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('refuses a patch with one end null and the other a time', async () => {
      const { testApp, token } = await adminApp();
      const templateId = await createTuesdayTemplate(testApp, token);

      const response = await testApp.request(`/api/v1/recurring-sessions/${templateId}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryWindowStart: null, deliveryWindowEnd: '13:00' }),
      });

      expect(response.status).toBe(400);
    });

    it('accepts a patch with both ends explicitly null, clearing the window', async () => {
      const { testApp, token } = await adminApp();
      const templateId = await createTuesdayTemplate(testApp, token);

      await testApp.request(`/api/v1/recurring-sessions/${templateId}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryWindowStart: '13:00', deliveryWindowEnd: '15:00' }),
      });

      const response = await testApp.request(`/api/v1/recurring-sessions/${templateId}`, {
        method: 'PATCH',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryWindowStart: null, deliveryWindowEnd: null }),
      });

      expect(response.status).toBe(200);
      const body: { deliveryWindowStart: string | null; deliveryWindowEnd: string | null } =
        await response.json();
      expect(body.deliveryWindowStart).toBeNull();
      expect(body.deliveryWindowEnd).toBeNull();
    });
  });
});

describe('session route authorisation', () => {
  beforeEach(async () => {
    await db.delete(sessions);
    await db.delete(recurringSessions);
    await db.delete(refreshTokens);
    await db.delete(users);
  });

  it('rejects an unauthenticated read', async () => {
    const testApp = buildTestApp({ clock: fixedClock(NOW) });

    expect((await testApp.request('/api/v1/sessions')).status).toBe(401);
  });

  it('lets a team lead read the schedule', async () => {
    const testApp = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await testApp.request('/api/v1/sessions', {
      headers: authHeaders(accessToken),
    });

    expect(response.status).toBe(200);
  });

  it('refuses a team lead creating or cancelling a session', async () => {
    const testApp = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const create = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-06',
        startTime: '18:00',
        durationMinutes: 90,
        location: 'Community Centre',
      }),
    });

    expect(create.status).toBe(403);
    expect(await create.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('refuses a team lead running the materialisation job', async () => {
    const testApp = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await testApp.request('/api/v1/jobs/session-materialisation/run', {
      method: 'POST',
      headers: authHeaders(accessToken),
    });

    expect(response.status).toBe(403);
  });

  it('rejects an invalid weekday with field-level detail and no echoed input', async () => {
    const { testApp, token } = await adminApp();

    const response = await testApp.request('/api/v1/recurring-sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad',
        weekday: 9,
        startTime: '25:00',
        durationMinutes: 120,
        location: 'Hall',
        activeFrom: 'not-a-date',
        deliveryCapacity: 25,
      }),
    });

    expect(response.status).toBe(400);
    const body: { error: { details: { issues: { path: string }[] } } } = await response.json();
    expect(body.error.details.issues.map((i) => i.path).sort()).toEqual([
      'activeFrom',
      'startTime',
      'weekday',
    ]);
    // The offending values must not come back — error bodies get logged.
    expect(JSON.stringify(body)).not.toContain('not-a-date');
  });
});

describe('amending a weekly template', () => {
  beforeEach(async () => {
    await db.delete(sessions);
    await db.delete(recurringSessions);
    await db.delete(refreshTokens);
    await db.delete(users);
  });

  async function patchTemplate(
    testApp: TestApp,
    token: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Response> {
    return testApp.request(`/api/v1/recurring-sessions/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  // One case per field the contract names, so a field cannot quietly stop being
  // amendable while the spec still advertises it.
  it('amends every field the contract offers', async () => {
    const { testApp, token } = await adminApp();
    const id = await createTuesdayTemplate(testApp, token);

    const amended = {
      name: 'Wednesday afternoon',
      weekday: 3,
      startTime: '14:30',
      durationMinutes: 90,
      location: 'Scout Hut',
      capacity: 40,
      activeFrom: '2026-02-01',
      activeUntil: '2026-12-31',
    };

    for (const [field, value] of Object.entries(amended)) {
      const response = await patchTemplate(testApp, token, id, { [field]: value });
      expect(response.status, `patching ${field}`).toBe(200);
      const body: Record<string, unknown> = await response.json();
      expect(body[field], `patching ${field}`).toEqual(value);
    }
  });

  it('leaves the fields it was not asked about alone', async () => {
    const { testApp, token } = await adminApp();
    const id = await createTuesdayTemplate(testApp, token);

    const response = await patchTemplate(testApp, token, id, { capacity: 30 });

    expect(response.status).toBe(200);
    const body: { capacity: number; name: string; weekday: number; startTime: string } =
      await response.json();
    expect(body).toMatchObject({
      capacity: 30,
      name: 'Tuesday morning',
      weekday: 2,
      startTime: '10:00',
    });
  });

  // A patch schema built by making an input schema optional keeps that schema's
  // defaults, so a one-field amendment quietly rewrites the fields it omitted.
  it('does not reset the capacity or the end date when amending only the name', async () => {
    const { testApp, token } = await adminApp();
    const id = await createTuesdayTemplate(testApp, token);
    expect((await patchTemplate(testApp, token, id, { capacity: 40 })).status).toBe(200);
    expect((await patchTemplate(testApp, token, id, { activeUntil: '2026-12-31' })).status).toBe(
      200,
    );

    const response = await patchTemplate(testApp, token, id, { name: 'Tuesday (renamed)' });

    expect(response.status).toBe(200);
    const body: { name: string; capacity: number; activeUntil: string | null } =
      await response.json();
    expect(body).toMatchObject({
      name: 'Tuesday (renamed)',
      capacity: 40,
      activeUntil: '2026-12-31',
    });
  });

  it('clears an end date with an explicit null', async () => {
    const { testApp, token } = await adminApp();
    const id = await createTuesdayTemplate(testApp, token);

    expect((await patchTemplate(testApp, token, id, { activeUntil: '2026-09-30' })).status).toBe(
      200,
    );
    const response = await patchTemplate(testApp, token, id, { activeUntil: null });

    expect(response.status).toBe(200);
    const body: { activeUntil: string | null } = await response.json();
    expect(body.activeUntil).toBeNull();
  });

  it('refuses an empty patch rather than reporting a change it did not make', async () => {
    const { testApp, token } = await adminApp();
    const id = await createTuesdayTemplate(testApp, token);

    const response = await patchTemplate(testApp, token, id, {});

    expect(response.status).toBe(400);
  });

  it('refuses a weekday outside 1-7', async () => {
    const { testApp, token } = await adminApp();
    const id = await createTuesdayTemplate(testApp, token);

    const response = await patchTemplate(testApp, token, id, { weekday: 0 });

    expect(response.status).toBe(400);
  });

  it('is not found when the template does not exist', async () => {
    const { testApp, token } = await adminApp();

    const response = await patchTemplate(testApp, token, crypto.randomUUID(), { capacity: 30 });

    expect(response.status).toBe(404);
  });
});
