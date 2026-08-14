import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { fixedClock } from '../src/core/clock.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import { submitReferral } from './helpers/referral-fixtures.ts';
import {
  generatePickList,
  readPickList,
  setUpPickingWorld,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

const db = createDatabase(env.DB);

/**
 * London's date on this instant is 2026-08-20, so the window is the fourteen
 * dates 2026-08-07 to 2026-08-20 inclusive. Both edges are asserted below;
 * getting the boundary wrong by a day is the most likely bug in this feature
 * and the least likely to be noticed.
 */
const NOW = '2026-08-20T09:00:00.000Z';
const EARLIEST_IN_WINDOW = '2026-08-07';
const JUST_OUTSIDE_WINDOW = '2026-08-06';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

/**
 * Referral submission is rate limited per client address, and these tests seed
 * several. A counter rather than a random address: two tests colliding on one
 * would fail for a reason that had nothing to do with fuel.
 */
let clientIpCounter = 0;
function nextClientIp(): string {
  clientIpCounter += 1;
  return `203.0.113.${String(clientIpCounter)}`;
}

async function adminWorld(): Promise<{ testApp: TestApp; token: string; world: PickingWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const built = await setUpPickingWorld(testApp, accessToken);

  await testApp.request('/api/v1/stock/take', {
    method: 'POST',
    headers: json(accessToken),
    body: JSON.stringify({
      counts: [
        { stockItemId: built.stockItems.Beans, countedQuantity: 500 },
        { stockItemId: built.stockItems.Pasta, countedQuantity: 500 },
        { stockItemId: built.stockItems.Cereal, countedQuantity: 500 },
      ],
    }),
  });

  return { testApp, token: accessToken, world: built };
}

/**
 * Drives a household all the way to "fed at a confirmed session".
 *
 * There is no shared helper for this: attendance needs the parcel reviewed
 * first, and confirming is refused while anybody on the session is still
 * unmarked, so every step here is a precondition of the next.
 */
async function fedAtSession(
  testApp: TestApp,
  token: string,
  w: PickingWorld,
  sessionDate: string,
  overrides: Record<string, unknown> = {},
  options: { attendance?: 'attended' | 'no_show'; confirm?: boolean; clientIp?: string } = {},
): Promise<{ sessionId: string; referralId: string }> {
  const created = await testApp.request('/api/v1/sessions', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      sessionDate,
      startTime: '10:00',
      durationMinutes: 120,
      location: 'Church Hall',
      capacity: 25,
    }),
  });
  const { id: sessionId }: { id: string } = await created.json();

  const { id: referralId } = await submitReferral(
    testApp,
    w,
    { sessionId, needsFuelHelp: true, ...overrides },
    { clientIp: options.clientIp ?? nextClientIp() },
  );

  const { id: pickListId } = await generatePickList(testApp, token, sessionId);
  const { parcels: rows } = await readPickList(testApp, token, pickListId);

  for (const parcel of rows) {
    await testApp.request(`/api/v1/parcels/${parcel.id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    await testApp.request(`/api/v1/parcels/${parcel.id}/attendance`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ attendance: options.attendance ?? 'attended' }),
    });
  }

  if (options.confirm !== false) {
    await testApp.request(`/api/v1/sessions/${sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });
  }

  return { sessionId, referralId };
}

interface FuelHousehold {
  referralId: string;
  sessionDate: string;
  refereeFirstName: string | null;
  refereeSurname: string | null;
  refereeDateOfBirth: string | null;
  refereeAddress: string | null;
  refereePostcode: string | null;
  refereePhone: string | null;
  answers: Record<string, unknown>;
}

async function readList(
  testApp: TestApp,
  token: string,
): Promise<{ status: number; households: FuelHousehold[] }> {
  const response = await testApp.request('/api/v1/fuel-help-list', {
    headers: authHeaders(token),
  });
  const body: { households?: FuelHousehold[] } = await response.json();
  return { status: response.status, households: body.households ?? [] };
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

describe('the fuel help list', () => {
  it('lists a household fed at a confirmed session inside the window', async () => {
    const { testApp, token, world } = await adminWorld();
    const { referralId } = await fedAtSession(testApp, token, world, '2026-08-18');

    const { status, households } = await readList(testApp, token);

    expect(status).toBe(200);
    expect(households).toEqual([
      {
        referralId,
        sessionDate: '2026-08-18',
        refereeFirstName: 'Alice',
        refereeSurname: 'Wintergreen',
        refereeDateOfBirth: '1985-03-14',
        refereeAddress: '12 Bramble Cottages',
        refereePostcode: 'GU1 4AA',
        refereePhone: '07700 900123',
        answers: { Dietary: 'no pork' },
      },
    ]);
  });

  it('carries the answers whole, and still lists a household who said not to ring them', async () => {
    const { testApp, token, world } = await adminWorld();
    await fedAtSession(testApp, token, world, '2026-08-18', {
      answers: {
        'Pre-payment meter': 'yes',
        'May we ring you about fuel': 'no',
        Dietary: 'no pork',
      },
    });

    const { households } = await readList(testApp, token);

    // The server picks nothing out of the blob, and refuses nobody on the
    // strength of it. Whoever makes the call reads the answer and decides.
    expect(households).toHaveLength(1);
    expect(households[0]?.answers).toEqual({
      'Pre-payment meter': 'yes',
      'May we ring you about fuel': 'no',
      Dietary: 'no pork',
    });
  });

  it('carries nothing beyond the agreed fields', async () => {
    const { testApp, token, world } = await adminWorld();
    await fedAtSession(testApp, token, world, '2026-08-18');

    const { households } = await readList(testApp, token);
    const row = households[0];

    // The mapper is the only output allowlist — the contract check cannot see
    // a widened response, so this is what stops a column leaking into it.
    for (const absent of [
      'reasonId',
      'reason',
      'adults',
      'children',
      'householdSize',
      'isDelivery',
      'needsFuelHelp',
      'referrerName',
      'referrerEmail',
      'referrerPhone',
      'reviewComment',
      'sessionId',
      'status',
    ]) {
      expect(row).not.toHaveProperty(absent);
    }
  });

  it('leaves out a household who did not ask for help with fuel', async () => {
    const { testApp, token, world } = await adminWorld();
    await fedAtSession(testApp, token, world, '2026-08-18', { needsFuelHelp: false });

    const { households } = await readList(testApp, token);

    expect(households).toEqual([]);
  });

  it('leaves out a household who did not turn up', async () => {
    const { testApp, token, world } = await adminWorld();
    await fedAtSession(testApp, token, world, '2026-08-18', {}, { attendance: 'no_show' });

    const { households } = await readList(testApp, token);

    expect(households).toEqual([]);
  });

  it('leaves out a session that has not been confirmed', async () => {
    const { testApp, token, world } = await adminWorld();
    await fedAtSession(testApp, token, world, '2026-08-18', {}, { confirm: false });

    // Attendance is marked, but the outcome can still be taken back, so
    // nobody should be rung about their gas bill yet.
    const { households } = await readList(testApp, token);

    expect(households).toEqual([]);
  });

  it('includes the oldest date in the window and excludes the day before it', async () => {
    const { testApp, token, world } = await adminWorld();
    await fedAtSession(testApp, token, world, EARLIEST_IN_WINDOW);
    await fedAtSession(testApp, token, world, JUST_OUTSIDE_WINDOW);

    const { households } = await readList(testApp, token);

    // Both edges in one test, so changing FUEL_HELP_WINDOW_DAYS fails loudly
    // rather than silently widening or narrowing the report.
    expect(households.map((h) => h.sessionDate)).toEqual([EARLIEST_IN_WINDOW]);
  });

  it('counts the fortnight in calendar dates across the end of British Summer Time', async () => {
    // The clocks go back on 2026-10-25, so this window spans the changeover and
    // contains one 25-hour day. Counted in dates it is still fourteen of them:
    // 2026-10-19 to 2026-11-01. Anything doing hour arithmetic instead would
    // pull the boundary an hour — and so a whole date — out of place.
    const testApp = buildTestApp({ clock: fixedClock('2026-11-01T09:00:00.000Z') });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpPickingWorld(testApp, accessToken);

    await fedAtSession(testApp, accessToken, world, '2026-10-19');
    await fedAtSession(testApp, accessToken, world, '2026-10-18');

    const { households } = await readList(testApp, accessToken);

    expect(households.map((h) => h.sessionDate)).toEqual(['2026-10-19']);
  });

  it('orders by session date, oldest first', async () => {
    const { testApp, token, world } = await adminWorld();
    await fedAtSession(testApp, token, world, '2026-08-14');
    await fedAtSession(testApp, token, world, '2026-08-08');
    await fedAtSession(testApp, token, world, '2026-08-19');

    const { households } = await readList(testApp, token);

    expect(households.map((h) => h.sessionDate)).toEqual([
      '2026-08-08',
      '2026-08-14',
      '2026-08-19',
    ]);
  });

  it('reports the session the parcel was issued at, not the one the referral was moved to', async () => {
    const { testApp, token, world } = await adminWorld();

    // Fed at the earlier session, then moved to a later one afterwards. The
    // parcel stays behind on the session it was picked for, and that is the
    // session the household was actually given food at.
    const fedAt = await fedAtSession(testApp, token, world, '2026-08-10', {}, { confirm: false });

    const later = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        sessionDate: '2026-08-19',
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Church Hall',
        capacity: 25,
      }),
    });
    const { id: laterSessionId }: { id: string } = await later.json();

    const moved = await testApp.request(`/api/v1/referrals/${fedAt.referralId}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ sessionId: laterSessionId, acknowledgeOverCapacity: true }),
    });
    expect(moved.status).toBe(200);

    await testApp.request(`/api/v1/sessions/${fedAt.sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const { households } = await readList(testApp, token);

    expect(households).toHaveLength(1);
    expect(households[0]?.sessionDate).toBe('2026-08-10');
  });

  it('gives a fuel administrator this list and nothing else in the API', async () => {
    const { testApp, token, world } = await adminWorld();
    const { sessionId } = await fedAtSession(testApp, token, world, '2026-08-18');

    // A distinct address: seedUser is idempotent by email, so reusing the
    // admin's would silently hand this login the admin's role.
    const fuel = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: fuelToken } = await devLogin(fuel, {
      email: 'fuel@foodbank.org',
      role: 'fuel_admin',
    });

    const list = await readList(fuel, fuelToken);
    expect(list.status).toBe(200);
    expect(list.households).toHaveLength(1);

    const me = await fuel.request('/api/v1/auth/me', { headers: authHeaders(fuelToken) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ role: 'fuel_admin' });

    // The boundary is enforced only by the absence of 'fuel_admin' from every
    // other route's guard, which nothing in the type system checks. This turns
    // that absence into an assertion. 403 specifically, not merely "not 200":
    // a 404 would mean the guard is missing and the route simply moved.
    // Every module with a guarded route is represented, so widening a tuple
    // anywhere is caught here rather than in production.
    for (const path of [
      '/api/v1/sessions',
      '/api/v1/recurring-sessions',
      '/api/v1/referrals',
      `/api/v1/sessions/${sessionId}/listener-sheet`,
      '/api/v1/stock/items',
      '/api/v1/stock/levels',
      '/api/v1/model-parcels',
      '/api/v1/parcel-grid',
      '/api/v1/users',
      '/api/v1/referral-reasons',
      '/api/v1/authorised-referrers',
      `/api/v1/sessions/${sessionId}/pick-list`,
      `/api/v1/sessions/${sessionId}/sms-summary`,
      '/api/v1/sms-messages/unmatched',
    ]) {
      const response = await fuel.request(path, { headers: authHeaders(fuelToken) });
      expect(response.status, `GET ${path} should be forbidden to a fuel administrator`).toBe(403);
    }

    // The write paths too — a guard is per route, so a read being closed says
    // nothing about the write beside it.
    for (const path of [
      `/api/v1/sessions/${sessionId}/pick-list`,
      `/api/v1/sessions/${sessionId}/confirm`,
      `/api/v1/sessions/${sessionId}/sms-reminders`,
      '/api/v1/stock/take',
    ]) {
      const response = await fuel.request(path, {
        method: 'POST',
        headers: json(fuelToken),
        body: '{}',
      });
      expect(response.status, `POST ${path} should be forbidden to a fuel administrator`).toBe(403);
    }
  });

  it('refuses a team leader', async () => {
    const { testApp, token, world } = await adminWorld();
    await fedAtSession(testApp, token, world, '2026-08-18');

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await lead.request('/api/v1/fuel-help-list', {
      headers: authHeaders(accessToken),
    });

    expect(response.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const testApp = buildTestApp({ clock: fixedClock(NOW) });

    const response = await testApp.request('/api/v1/fuel-help-list');

    expect(response.status).toBe(401);
  });
});
