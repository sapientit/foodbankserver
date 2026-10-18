import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions, type SessionStatus } from '../src/db/schema/sessions.ts';
import { smsMessages } from '../src/db/schema/sms.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  generatePickList,
  readPickList,
  reviewEveryParcel,
  setUpPickingWorld,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';
import { submitReferral } from './helpers/referral-fixtures.ts';

/**
 * A team lead cannot see a closed (confirmed or cancelled) session by any
 * route: 404, never 403, and ahead of any 409. Status only — a session whose
 * date has passed but is not confirmed stays visible. Admins are unaffected.
 *
 * Every refusal here is paired with an admin getting a real answer to the same
 * request, so a 404 that is really "the route does not exist" or "the fixture
 * is wrong" cannot pass.
 */

const db = createDatabase(env.DB);
// The fixture session is 2026-08-11: inside a team lead's six-day horizon from here.
const NOW = '2026-08-10T09:00:00.000Z';
const LATER = '2026-08-20T09:00:00.000Z'; // the session's day has gone by

const ADMIN_EMAIL = 'admin@foodbank.org';
const LEAD_EMAIL = 'lead@foodbank.org';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

interface Ids {
  readonly sessionId: string;
  readonly pickListId: string;
  readonly parcelId: string;
  readonly referralId: string;
  readonly stockItemId: string;
}

interface Built extends Ids {
  readonly testApp: TestApp;
  readonly admin: string;
  readonly lead: string;
  readonly world: PickingWorld;
  /** A second, still-planned session with its own referral, so "still listed" is provable. */
  readonly openSessionId: string;
  readonly openReferralId: string;
}

/** Referral submission is rate limited per address, so each build uses new ones. */
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `203.0.118.${String(ipCounter)}`;
}

async function wipe(): Promise<void> {
  await db.delete(smsMessages);
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
}

/**
 * One household, picked, reviewed and marked attended (so the ledger holds
 * rows), an unread reply from them, and a second open session with a
 * referral. The session under test is left `planned`; `close` closes it.
 */
async function build(): Promise<Built> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken: admin } = await devLogin(testApp, { email: ADMIN_EMAIL });
  const { accessToken: lead } = await devLogin(testApp, { email: LEAD_EMAIL, role: 'team_lead' });
  const world = await setUpPickingWorld(testApp, admin);

  await testApp.request('/api/v1/stock/take', {
    method: 'POST',
    headers: json(admin),
    body: JSON.stringify({
      counts: [
        { stockItemId: world.stockItems.Beans, countedQuantity: 100 },
        { stockItemId: world.stockItems.Pasta, countedQuantity: 100 },
        { stockItemId: world.stockItems.Cereal, countedQuantity: 100 },
      ],
    }),
  });

  const referral = await submitReferral(
    testApp,
    world,
    { adults: 1, children: 0 },
    { clientIp: freshIp() },
  );
  expect(referral.status).toBe(201);
  const { id: pickListId } = await generatePickList(testApp, admin, world.sessionId);
  await reviewEveryParcel(testApp, admin, pickListId);
  const { parcels: rows } = await readPickList(testApp, admin, pickListId);
  const parcelId = rows[0]?.id ?? '';
  const attended = await testApp.request(`/api/v1/parcels/${parcelId}/attendance`, {
    method: 'POST',
    headers: json(admin),
    body: JSON.stringify({ attendance: 'attended' }),
  });
  expect(attended.status).toBe(200);

  const openResponse = await testApp.request('/api/v1/sessions', {
    method: 'POST',
    headers: json(admin),
    body: JSON.stringify({
      sessionDate: '2026-08-12',
      startTime: '10:00',
      durationMinutes: 120,
      location: 'Annexe',
      capacity: 25,
      deliveryCapacity: 0,
    }),
  });
  expect(openResponse.status).toBe(201);
  const { id: openSessionId }: { id: string } = await openResponse.json();
  const open = await submitReferral(
    testApp,
    { ...world, sessionId: openSessionId },
    { adults: 2, children: 0, refereeFirstName: 'Bob', refereePhone: '07700 900456' },
    { clientIp: freshIp() },
  );
  expect(open.status).toBe(201);

  // An unread reply, so "nothing marked read" has something to fail on.
  const now = NOW;
  await db.insert(smsMessages).values({
    id: crypto.randomUUID(),
    referralId: referral.id,
    sessionId: world.sessionId,
    kind: 'household_reply',
    phone: '+447700900123',
    body: 'Can I come at eleven?',
    providerMessageId: `prov-${crypto.randomUUID()}`,
    occurredAt: now,
    readAt: null,
    sentByUserId: null,
    recipientRole: 'referee',
    simulated: false,
    createdAt: now,
    updatedAt: now,
  });

  return {
    testApp,
    admin,
    lead,
    world,
    sessionId: world.sessionId,
    pickListId,
    parcelId,
    referralId: referral.id,
    stockItemId: world.stockItems.Beans,
    openSessionId,
    openReferralId: open.id,
  };
}

async function close(sessionId: string, status: Extract<SessionStatus, 'confirmed' | 'cancelled'>) {
  await db
    .update(sessions)
    .set({ status, confirmedAt: status === 'confirmed' ? NOW : null, updatedAt: NOW })
    .where(eq(sessions.id, sessionId));
}

interface Call {
  readonly name: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: (ids: Ids) => string;
  readonly body?: (ids: Ids) => unknown;
}

const API = '/api/v1';

/** Every route that reaches a session, directly or through its pick list, parcel or referral. */
const SESSION_REACHING_ROUTES: readonly Call[] = [
  { name: 'GET /sessions/:id', method: 'GET', path: (i) => `${API}/sessions/${i.sessionId}` },
  {
    name: 'POST /sessions/:id/pick-list',
    method: 'POST',
    path: (i) => `${API}/sessions/${i.sessionId}/pick-list`,
  },
  {
    name: 'GET /sessions/:id/pick-list',
    method: 'GET',
    path: (i) => `${API}/sessions/${i.sessionId}/pick-list`,
  },
  { name: 'GET /pick-lists/:id', method: 'GET', path: (i) => `${API}/pick-lists/${i.pickListId}` },
  {
    name: 'GET /pick-lists/:id/divergence',
    method: 'GET',
    path: (i) => `${API}/pick-lists/${i.pickListId}/divergence`,
  },
  {
    name: 'GET /pick-lists/:id/print',
    method: 'GET',
    path: (i) => `${API}/pick-lists/${i.pickListId}/print`,
  },
  {
    name: 'POST /pick-lists/:id/print',
    method: 'POST',
    path: (i) => `${API}/pick-lists/${i.pickListId}/print`,
  },
  {
    name: 'GET /sessions/:id/stock-requirement',
    method: 'GET',
    path: (i) => `${API}/sessions/${i.sessionId}/stock-requirement`,
  },
  {
    name: 'PUT /parcels/:id/lines',
    method: 'PUT',
    path: (i) => `${API}/parcels/${i.parcelId}/lines`,
    body: (i) => ({ stockItemId: i.stockItemId, quantity: 3 }),
  },
  {
    name: 'DELETE /parcels/:id/lines/:stockItemId',
    method: 'DELETE',
    path: (i) => `${API}/parcels/${i.parcelId}/lines/${i.stockItemId}`,
  },
  {
    name: 'POST /parcels/:id/review',
    method: 'POST',
    path: (i) => `${API}/parcels/${i.parcelId}/review`,
  },
  {
    name: 'POST /parcels/:id/attendance (repeat of the recorded outcome)',
    method: 'POST',
    path: (i) => `${API}/parcels/${i.parcelId}/attendance`,
    body: () => ({ attendance: 'attended' }),
  },
  {
    name: 'POST /parcels/:id/attendance (a change of outcome)',
    method: 'POST',
    path: (i) => `${API}/parcels/${i.parcelId}/attendance`,
    body: () => ({ attendance: 'no_show' }),
  },
  {
    name: 'POST /sessions/:id/confirm',
    method: 'POST',
    path: (i) => `${API}/sessions/${i.sessionId}/confirm`,
  },
  {
    name: 'GET /sessions/:id/listener-sheet',
    method: 'GET',
    path: (i) => `${API}/sessions/${i.sessionId}/listener-sheet`,
  },
  {
    name: 'GET /sessions/:id/referral-details',
    method: 'GET',
    path: (i) => `${API}/sessions/${i.sessionId}/referral-details`,
  },
  {
    name: 'GET /sessions/:id/model-summary',
    method: 'GET',
    path: (i) => `${API}/sessions/${i.sessionId}/model-summary`,
  },
  { name: 'GET /referrals/:id', method: 'GET', path: (i) => `${API}/referrals/${i.referralId}` },
  {
    name: 'POST /sessions/:id/sms-reminders',
    method: 'POST',
    path: (i) => `${API}/sessions/${i.sessionId}/sms-reminders`,
  },
  {
    name: 'GET /sessions/:id/sms-summary',
    method: 'GET',
    path: (i) => `${API}/sessions/${i.sessionId}/sms-summary`,
  },
  {
    name: 'GET /referrals/:id/sms-messages',
    method: 'GET',
    path: (i) => `${API}/referrals/${i.referralId}/sms-messages`,
  },
  {
    name: 'POST /referrals/:id/sms-messages/read',
    method: 'POST',
    path: (i) => `${API}/referrals/${i.referralId}/sms-messages/read`,
  },
  {
    name: 'POST /referrals/:id/sms-messages',
    method: 'POST',
    path: (i) => `${API}/referrals/${i.referralId}/sms-messages`,
    body: () => ({ body: 'See you there' }),
  },
];

async function call(
  testApp: TestApp,
  token: string,
  route: Call,
  ids: Ids,
): Promise<{ status: number; body: { error?: { code?: string; message?: string } } }> {
  const body = route.body?.(ids);
  const response = await testApp.request(route.path(ids), {
    method: route.method,
    headers: body === undefined ? authHeaders(token) : json(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) };
}

/** The same request with every id replaced by one that does not exist. */
function unknownIds(): Ids {
  return {
    sessionId: crypto.randomUUID(),
    pickListId: crypto.randomUUID(),
    parcelId: crypto.randomUUID(),
    referralId: crypto.randomUUID(),
    stockItemId: crypto.randomUUID(),
  };
}

/** Everything a refused call could have changed, in one comparable value. */
async function snapshot(): Promise<string> {
  return JSON.stringify({
    ledger: await db.select().from(stockLedger).orderBy(stockLedger.id),
    lines: await db.select().from(parcelLines).orderBy(parcelLines.id),
    parcels: await db.select().from(parcels).orderBy(parcels.id),
    pickLists: await db.select().from(pickLists).orderBy(pickLists.id),
    sms: await db.select().from(smsMessages).orderBy(smsMessages.id),
    referrals: await db.select().from(referrals).orderBy(referrals.id),
    sessions: await db.select().from(sessions).orderBy(sessions.id),
  });
}

describe.each(['confirmed', 'cancelled'] as const)(
  'a team lead and a %s session',
  (closedStatus) => {
    let built: Built;
    let ids: Ids;
    let before: string;

    // Built once: every request here is a refusal, and the snapshot test below
    // is what proves none of them changed anything.
    beforeAll(async () => {
      await wipe();
      built = await build();
      ids = built;
      await close(built.sessionId, closedStatus);
      before = await snapshot();
    });

    it.each(SESSION_REACHING_ROUTES.map((route) => [route.name, route] as const))(
      'gets 404 NOT_FOUND, not 403 or 409, from %s',
      async (_name, route) => {
        const result = await call(built.testApp, built.lead, route, ids);

        expect(result.status).toBe(404);
        expect(result.body.error?.code).toBe('NOT_FOUND');
      },
    );

    it.each(SESSION_REACHING_ROUTES.map((route) => [route.name, route] as const))(
      'gets the same 404 from %s as for ids that do not exist',
      async (_name, route) => {
        const real = await call(built.testApp, built.lead, route, ids);
        const missing = await call(built.testApp, built.lead, route, unknownIds());

        expect(missing.status).toBe(404);
        expect(real.status).toBe(missing.status);
        expect(real.body.error?.code).toBe(missing.body.error?.code);
        expect(real.body.error?.message).toBe(missing.body.error?.message);
      },
    );

    it('changes nothing in the ledger, parcels, messages, referrals or sessions however many routes it tries', async () => {
      for (const route of SESSION_REACHING_ROUTES) {
        await call(built.testApp, built.lead, route, ids);
      }

      expect(await snapshot()).toBe(before);
    });

    it('leaves the unread reply unread when it tries to mark the thread read', async () => {
      await call(
        built.testApp,
        built.lead,
        {
          name: 'read',
          method: 'POST',
          path: (i) => `${API}/referrals/${i.referralId}/sms-messages/read`,
        },
        ids,
      );

      const rows = await db
        .select()
        .from(smsMessages)
        .where(eq(smsMessages.kind, 'household_reply'));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.readAt).toBeNull();
    });

    it('stores and sends no message when it tries to text a household', async () => {
      const count = (await db.select().from(smsMessages)).length;

      const reply = await call(
        built.testApp,
        built.lead,
        {
          name: 'reply',
          method: 'POST',
          path: (i) => `${API}/referrals/${i.referralId}/sms-messages`,
          body: () => ({ body: 'See you there' }),
        },
        ids,
      );
      const reminders = await call(
        built.testApp,
        built.lead,
        {
          name: 'reminders',
          method: 'POST',
          path: (i) => `${API}/sessions/${i.sessionId}/sms-reminders`,
        },
        ids,
      );

      expect(reply.status).toBe(404);
      expect(reminders.status).toBe(404);
      expect(await db.select().from(smsMessages)).toHaveLength(count);
      const [referral] = await db.select().from(referrals).where(eq(referrals.id, ids.referralId));
      expect(referral?.smsReminderSentAt).toBeNull();
    });

    it('leaves the recorded attendance and its ledger rows alone, for a repeat and for a change', async () => {
      const ledgerBefore = JSON.stringify(
        await db.select().from(stockLedger).orderBy(stockLedger.id),
      );
      expect(JSON.parse(ledgerBefore)).not.toHaveLength(0); // something to fail on

      for (const attendance of ['attended', 'no_show']) {
        const response = await built.testApp.request(`${API}/parcels/${ids.parcelId}/attendance`, {
          method: 'POST',
          headers: json(built.lead),
          body: JSON.stringify({ attendance }),
        });
        expect(response.status).toBe(404);
      }

      expect(JSON.stringify(await db.select().from(stockLedger).orderBy(stockLedger.id))).toBe(
        ledgerBefore,
      );
      const [parcel] = await db.select().from(parcels).where(eq(parcels.id, ids.parcelId));
      expect(parcel?.attendance).toBe('attended');
    });

    it('does not see the session in the list, or when asking for its status by name', async () => {
      const list = async (query = '') => {
        const response = await built.testApp.request(`${API}/sessions${query}`, {
          headers: authHeaders(built.lead),
        });
        expect(response.status).toBe(200);
        const body: { sessions: { id: string }[] } = await response.json();
        return body.sessions.map((session) => session.id);
      };

      const all = await list();
      expect(all).not.toContain(built.sessionId);
      expect(all).toContain(built.openSessionId); // the list is not simply empty
      expect(await list('?status=confirmed')).toEqual([]);
      expect(await list('?status=cancelled')).toEqual([]);
      expect(await list('?status=planned')).toContain(built.openSessionId);
    });

    it('does not see a referral on it in the list, with or without sessionId, but still sees an open session’s', async () => {
      const list = async (query = '') => {
        const response = await built.testApp.request(`${API}/referrals${query}`, {
          headers: authHeaders(built.lead),
        });
        expect(response.status).toBe(200);
        const body: { referrals: { id: string }[] } = await response.json();
        return body.referrals.map((referral) => referral.id);
      };

      const all = await list();
      expect(all).not.toContain(built.referralId);
      expect(all).toContain(built.openReferralId);
      expect(await list(`?sessionId=${built.sessionId}`)).toEqual([]);
      expect(await list(`?sessionId=${built.openSessionId}`)).toEqual([built.openReferralId]);
    });

    it('is the only one refused: an admin lists the same session and referral', async () => {
      const sessionList = await built.testApp.request(`${API}/sessions`, {
        headers: authHeaders(built.admin),
      });
      const sessionBody: { sessions: { id: string }[] } = await sessionList.json();
      expect(sessionBody.sessions.map((s) => s.id)).toContain(built.sessionId);

      const referralList = await built.testApp.request(
        `${API}/referrals?sessionId=${built.sessionId}`,
        {
          headers: authHeaders(built.admin),
        },
      );
      const referralBody: { referrals: { id: string }[] } = await referralList.json();
      expect(referralBody.referrals.map((r) => r.id)).toEqual([built.referralId]);
    });
  },
);

describe('an admin and a closed session', () => {
  beforeEach(wipe);

  /** Representative reads and writes across every module the rule reaches. */
  const ADMIN_CONTROLS: readonly (readonly [string, number])[] = [
    ['GET /sessions/:id', 200],
    ['GET /sessions/:id/pick-list', 200],
    ['GET /pick-lists/:id', 200],
    ['GET /pick-lists/:id/divergence', 200],
    ['GET /sessions/:id/stock-requirement', 200],
    ['GET /sessions/:id/referral-details', 200],
    ['GET /sessions/:id/model-summary', 200],
    ['GET /referrals/:id', 200],
    ['GET /sessions/:id/sms-summary', 200],
    ['GET /referrals/:id/sms-messages', 200],
    ['POST /referrals/:id/sms-messages/read', 204],
    ['POST /referrals/:id/sms-messages', 201],
    ['POST /parcels/:id/attendance (repeat of the recorded outcome)', 200],
    ['POST /sessions/:id/confirm', 200],
  ];

  describe.each(['confirmed', 'cancelled'] as const)('on a %s session', (closedStatus) => {
    it.each(ADMIN_CONTROLS)('gets the normal answer from %s', async (name, expected) => {
      const built = await build();
      await close(built.sessionId, closedStatus);
      const route = SESSION_REACHING_ROUTES.find((candidate) => candidate.name === name);
      if (route === undefined) throw new Error(`No route named ${name}`);

      // The cancelled case has nothing to confirm; an admin's confirm of it
      // is whatever the service decides, so only the confirmed one is pinned.
      if (closedStatus === 'cancelled' && name === 'POST /sessions/:id/confirm') return;

      const result = await call(built.testApp, built.admin, route, built);

      // An admin's stock requirement on a confirmed session is the 409 the
      // team lead's 404 must come ahead of.
      const stockRequirementConfirmed =
        closedStatus === 'confirmed' && name === 'GET /sessions/:id/stock-requirement';
      expect(result.status).toBe(stockRequirementConfirmed ? 409 : expected);
    });
  });
});

describe('confirming', () => {
  beforeEach(wipe);

  it('lets a team lead confirm once, then 404s their repeat, while an admin repeat is still 200', async () => {
    const built = await build();
    const confirm = (token: string) =>
      built.testApp.request(`${API}/sessions/${built.sessionId}/confirm`, {
        method: 'POST',
        headers: authHeaders(token),
      });

    expect((await confirm(built.lead)).status).toBe(200);
    expect((await confirm(built.lead)).status).toBe(404);
    expect((await confirm(built.admin)).status).toBe(200);
    expect((await confirm(built.admin)).status).toBe(200);
  });

  it('404s a team lead who confirms a cancelled session', async () => {
    const built = await build();
    await close(built.sessionId, 'cancelled');

    const response = await built.testApp.request(`${API}/sessions/${built.sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(built.lead),
    });

    expect(response.status).toBe(404);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, built.sessionId));
    expect(session?.status).toBe('cancelled');
  });
});

describe('a session whose date has passed but is not confirmed', () => {
  beforeEach(wipe);

  it('is still listed, readable, workable and confirmable by a team lead', async () => {
    const built = await build();
    // Same database, a later day.
    const later = buildTestApp({ clock: fixedClock(LATER) });
    const { accessToken: lead } = await devLogin(later, { email: LEAD_EMAIL, role: 'team_lead' });

    const listed = await later.request(`${API}/sessions`, { headers: authHeaders(lead) });
    const listedBody: { sessions: { id: string }[] } = await listed.json();
    expect(listedBody.sessions.map((s) => s.id)).toContain(built.sessionId);

    const byId = await later.request(`${API}/sessions/${built.sessionId}`, {
      headers: authHeaders(lead),
    });
    expect(byId.status).toBe(200);

    // A change of outcome is the work an unconfirmed session exists for.
    const change = await later.request(`${API}/parcels/${built.parcelId}/attendance`, {
      method: 'POST',
      headers: json(lead),
      body: JSON.stringify({ attendance: 'no_show' }),
    });
    expect(change.status).toBe(200);

    const confirm = () =>
      later.request(`${API}/sessions/${built.sessionId}/confirm`, {
        method: 'POST',
        headers: authHeaders(lead),
      });
    expect((await confirm()).status).toBe(200);
    // Only now is it closed to them.
    expect((await confirm()).status).toBe(404);
  });
});
