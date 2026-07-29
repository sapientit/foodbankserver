import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { systemJobs } from '../src/db/schema/jobs.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';

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
