import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { auditEvents, referralEditKeys, referrals } from '../src/db/schema/referrals.ts';
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

    // No capacity, no remaining places, no status, no internal flags.
    expect(Object.keys(body.sessions[0] ?? {}).sort()).toEqual([
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
    await db.delete(referralEditKeys);
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
    expect(body.sessions.map((s) => s.sessionDate)).toEqual([
      TODAY,
      TOMORROW,
      SIX_DAYS_OUT,
      SEVEN_DAYS_OUT,
    ]);
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
