import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_PREFIX } from '../src/app.ts';
import { fixedClock } from '../src/core/clock.ts';
import { createLogger } from '../src/core/log.ts';
import { createDatabase } from '../src/db/client.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { smsMessages } from '../src/db/schema/sms.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { purgeSmsMessages } from '../src/modules/jobs/purge-sms.ts';
import { composeReferrerReminder, composeReminder } from '../src/modules/sms/messages.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import { generatePickList, setUpPickingWorld } from './helpers/picking-fixtures.ts';
import {
  setUpReferralWorld,
  submitReferral,
  UNKNOWN_REFERRER,
} from './helpers/referral-fixtures.ts';

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z'; // a Tuesday morning
const WEBHOOK_SECRET = 'webhookuser:webhookpass1234';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

function basicAuth(secret: string): Record<string, string> {
  return { authorization: `Basic ${btoa(secret)}` };
}

/**
 * The real application, wired as production wires it — these routes are
 * mounted in `app.ts`, so nothing here mounts them by hand. That is the point:
 * a test that mounted its own copy would pass even if the module were never
 * reachable in the running Worker.
 */
function buildSmsTestApp(bindings: Record<string, unknown> = {}): TestApp {
  return buildTestApp({
    clock: fixedClock(NOW),
    bindings: { SMS_API_KEY: 'test-key', SMS_SENDER: 'FOODBANK', ...bindings },
  });
}

/** A provider response shaped the way `provider.ts` reads it: `result.messageid`. */
function providerSuccess(messageId: string): Response {
  return new Response(JSON.stringify({ result: { messageid: messageId } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function createSession(
  testApp: TestApp,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await testApp.request(`${API_PREFIX}/sessions`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      sessionDate: '2026-08-11',
      startTime: '10:00',
      durationMinutes: 120,
      location: 'Church Hall',
      capacity: 25,
      deliveryCapacity: 25,
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  const body: { id: string } = await response.json();
  return body.id;
}

beforeEach(async () => {
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sending reminders', () => {
  it('sends a household holding a place a reminder and sets the flag', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-1'));

    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    const { id: referralId } = await submitReferral(testApp, world);

    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });
    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      { method: 'POST', headers: authHeaders(accessToken) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reminded: 1, failed: 0, alreadyReminded: 0 });

    // The secret goes to the provider and nowhere else in the request.
    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe('https://api.thesmsworks.co.uk/v1/message/send');
    expect(call?.[1]?.headers).toMatchObject({ authorization: 'test-key' });

    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    expect(referral?.smsReminderSentAt).not.toBeNull();

    const [row] = await db.select().from(smsMessages).where(eq(smsMessages.referralId, referralId));
    expect(row).toMatchObject({ kind: 'reminder', phone: '+447700900123' });
    expect(row?.readAt).not.toBeNull(); // outbound — read on arrival
  });

  it('does not send a household a second reminder once one has gone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-1'));

    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, world);

    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });
    const first = await testApp.request(`${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });
    expect(await first.json()).toMatchObject({ reminded: 1, failed: 0 });

    const second = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      {
        method: 'POST',
        headers: authHeaders(accessToken),
      },
    );
    // The second press has nothing to do, and says so rather than
    // returning zeroes that read as a failure.
    expect(await second.json()).toMatchObject({
      reminded: 0,
      failed: 0,
      alreadyReminded: 1,
    });

    const rows = await db.select().from(smsMessages);
    expect(rows).toHaveLength(1); // not a second reminder row
  });

  it('reminds a household still waiting to be reviewed, unlike picking', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-1'));

    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    await submitReferral(testApp, world, UNKNOWN_REFERRER); // lands pending_review

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      {
        method: 'POST',
        headers: authHeaders(accessToken),
      },
    );

    expect(await response.json()).toMatchObject({ reminded: 1, failed: 0 });
  });

  it('does not remind a cancelled or rejected referral', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-1'));

    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    const { id: toCancel } = await submitReferral(testApp, world);
    await testApp.request(`${API_PREFIX}/referrals/${toCancel}/cancel`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });

    const { id: toReject } = await submitReferral(testApp, world, UNKNOWN_REFERRER);
    await testApp.request(`${API_PREFIX}/referrals/${toReject}/reject`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      {
        method: 'POST',
        headers: authHeaders(accessToken),
      },
    );

    expect(await response.json()).toMatchObject({ reminded: 0, failed: 0, alreadyReminded: 0 });
  });

  it('records a household with no phone as a failure and leaves the flag unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world, { refereePhone: undefined });

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      {
        method: 'POST',
        headers: authHeaders(accessToken),
      },
    );

    expect(await response.json()).toMatchObject({ reminded: 0, failed: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();

    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    expect(referral?.smsReminderSentAt).toBeNull();

    const [row] = await db.select().from(smsMessages).where(eq(smsMessages.referralId, referralId));
    expect(row?.kind).toBe('failure');
    expect(row?.readAt).not.toBeNull(); // a failure is recorded already read
  });

  it('retries a household whose reminder failed on the next press', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 500 }));
    const first = await testApp.request(`${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });
    expect(await first.json()).toMatchObject({ reminded: 0, failed: 1 });

    const [afterFailure] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    expect(afterFailure?.smsReminderSentAt).toBeNull();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(providerSuccess('prov-retry'));
    const second = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      {
        method: 'POST',
        headers: authHeaders(accessToken),
      },
    );
    // A failure never counted as reminded, so the retry finds them again
    // rather than reporting them as already done.
    expect(await second.json()).toMatchObject({
      reminded: 1,
      failed: 0,
      alreadyReminded: 0,
    });

    const [afterSuccess] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    expect(afterSuccess?.smsReminderSentAt).not.toBeNull();

    const rows = await db.select().from(smsMessages).where(eq(smsMessages.referralId, referralId));
    expect(rows).toHaveLength(2); // a failure row, then a reminder row
  });

  it('team lead may send reminders', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-1'));

    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, world);

    const { accessToken: leadToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });
    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      {
        method: 'POST',
        headers: authHeaders(leadToken),
      },
    );

    expect(response.status).toBe(200);
  });

  it('does not remind a household whose parcel was already picked before it was cancelled', async () => {
    // The same exclusion as above, but in the shape a real session produces:
    // cancelling after generation marks the parcel cancelled rather than
    // touching the referral row a second way, so this proves the reminder
    // list still comes from the referral's own status.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-1'));

    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const pickingWorld = await setUpPickingWorld(testApp, accessToken);
    await submitReferral(testApp, pickingWorld);
    const { id: toCancel } = await submitReferral(testApp, pickingWorld);

    await generatePickList(testApp, accessToken, pickingWorld.sessionId);

    await testApp.request(`${API_PREFIX}/referrals/${toCancel}/cancel`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${pickingWorld.sessionId}/sms-reminders`,
      { method: 'POST', headers: authHeaders(accessToken) },
    );

    expect(await response.json()).toMatchObject({ reminded: 1, failed: 0, alreadyReminded: 0 });
  });
});

describe('the dev/test SMS simulator', () => {
  /** The shape `toSmsMessageResponse` produces on the thread endpoint. */
  interface ThreadMessage {
    readonly kind: string;
    readonly body: string;
    readonly phone: string;
    readonly simulated: boolean;
  }

  async function getThread(
    testApp: TestApp,
    token: string,
    referralId: string,
  ): Promise<ThreadMessage[]> {
    const response = await testApp.request(`${API_PREFIX}/referrals/${referralId}/sms-messages`, {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);
    const body: { messages: ThreadMessage[] } = await response.json();
    return body.messages;
  }

  it('records a failure and leaves the flag unset when no provider is configured and simulate is off', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // The ambient dev env carries SMS_SIMULATE=true (see wrangler.jsonc); this
    // is the plain pre-existing behaviour, so it has to turn simulate off and
    // remove the provider `buildSmsTestApp` otherwise defaults on.
    const testApp = buildSmsTestApp({
      SMS_API_KEY: undefined,
      SMS_SENDER: undefined,
      SMS_SIMULATE: '',
    });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      { method: 'POST', headers: authHeaders(accessToken) },
    );
    expect(await response.json()).toMatchObject({ reminded: 0, failed: 1, simulated: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();

    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    expect(referral?.smsReminderSentAt).toBeNull();

    const [row] = await db.select().from(smsMessages).where(eq(smsMessages.referralId, referralId));
    expect(row).toMatchObject({ kind: 'failure', body: 'SMS sending is not configured' });
    expect(row?.simulated).toBe(false);
  });

  it('fakes a successful send and sets the flag when no provider is configured but simulate is on', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const testApp = buildSmsTestApp({
      SMS_API_KEY: undefined,
      SMS_SENDER: undefined,
      SMS_SIMULATE: 'true',
    });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      { method: 'POST', headers: authHeaders(accessToken) },
    );
    expect(await response.json()).toMatchObject({ reminded: 1, failed: 0, simulated: 1 });
    expect(fetchSpy).not.toHaveBeenCalled(); // simulated — never reaches the real provider

    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    expect(referral?.smsReminderSentAt).not.toBeNull();

    const messages = await getThread(testApp, accessToken, referralId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'reminder', simulated: true });
    expect(messages[0]?.body.length).toBeGreaterThan(0);
  });

  it('does not call the real provider for a destination outside SMS_LIVE_NUMBER, and records a simulated success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const testApp = buildSmsTestApp({
      // A number that is not the referral's own — see `submission()`'s default `07700 900123`.
      SMS_LIVE_NUMBER: '07700 900999',
      SMS_SIMULATE: 'true',
    });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      { method: 'POST', headers: authHeaders(accessToken) },
    );
    expect(await response.json()).toMatchObject({ reminded: 1, failed: 0, simulated: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();

    const messages = await getThread(testApp, accessToken, referralId);
    expect(messages[0]).toMatchObject({ kind: 'reminder', simulated: true });
  });

  it('really calls the provider for a destination matching SMS_LIVE_NUMBER, even spelled differently', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-live'));

    const testApp = buildSmsTestApp({
      // The referral's own `07700 900123`, spelled as E.164 — proves the match
      // is `phonesMatch`, not a naive string compare.
      SMS_LIVE_NUMBER: '+447700900123',
      SMS_SIMULATE: 'true',
    });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      { method: 'POST', headers: authHeaders(accessToken) },
    );
    expect(await response.json()).toMatchObject({ reminded: 1, failed: 0, simulated: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const messages = await getThread(testApp, accessToken, referralId);
    expect(messages[0]).toMatchObject({ kind: 'reminder', simulated: false });
  });

  it('records a restricted-test-number failure for a non-live destination when simulate is off', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const testApp = buildSmsTestApp({
      SMS_LIVE_NUMBER: '07700 900999',
      SMS_SIMULATE: '',
    });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      { method: 'POST', headers: authHeaders(accessToken) },
    );
    expect(await response.json()).toMatchObject({ reminded: 0, failed: 1, simulated: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();

    const [row] = await db.select().from(smsMessages).where(eq(smsMessages.referralId, referralId));
    expect(row).toMatchObject({
      kind: 'failure',
      body: 'SMS sending is restricted to a test number in this environment',
    });
    expect(row?.simulated).toBe(false);
  });

  it('lets a staff reply succeed as a simulated send rather than throwing, for a non-live destination', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const testApp = buildSmsTestApp({
      SMS_LIVE_NUMBER: '07700 900999',
      SMS_SIMULATE: 'true',
    });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    const response = await testApp.request(`${API_PREFIX}/referrals/${referralId}/sms-messages`, {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({ body: 'We can still come to you' }),
    });

    expect(response.status).toBe(201);
    const body: { kind: string; simulated: boolean } = await response.json();
    expect(body).toMatchObject({ kind: 'staff_reply', simulated: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records a real provider failure as a failure even when simulate is on', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));

    // A live, configured destination that actually reaches the provider —
    // simulate must not mask a genuine provider failure as a fake success.
    const testApp = buildSmsTestApp({ SMS_SIMULATE: 'true' });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      { method: 'POST', headers: authHeaders(accessToken) },
    );
    expect(await response.json()).toMatchObject({ reminded: 0, failed: 1, simulated: 0 });

    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    expect(referral?.smsReminderSentAt).toBeNull();

    const [row] = await db.select().from(smsMessages).where(eq(smsMessages.referralId, referralId));
    expect(row?.kind).toBe('failure');
    expect(row?.body).toMatch(/^Send failed:/);
    expect(row?.simulated).toBe(false);
  });
});

describe('the session summary', () => {
  it('excludes outbound rows from the counts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-1'));

    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    // One outbound reminder …
    await testApp.request(`${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });
    // … and a staff reply, also outbound.
    await testApp.request(`${API_PREFIX}/referrals/${referralId}/sms-messages`, {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({ body: 'Thanks for letting us know' }),
    });

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-summary`,
      {
        headers: authHeaders(accessToken),
      },
    );
    const body: {
      unreadTotal: number;
      households: {
        referralId: string;
        sent: boolean;
        messageCount: number;
        unreadCount: number;
      }[];
    } = await response.json();

    expect(body.unreadTotal).toBe(0);
    expect(body.households).toEqual([{ referralId, sent: true, messageCount: 0, unreadCount: 0 }]);
  });

  it('counts a household reply and a failure, but a failure is never unread', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await testApp.request(`${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });

    await testApp.request(`${API_PREFIX}/webhooks/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: '07700 900123', content: 'Running late', messageid: 'p-1' }),
    });

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-summary`,
      {
        headers: authHeaders(accessToken),
      },
    );
    const body: {
      unreadTotal: number;
      households: { messageCount: number; unreadCount: number }[];
    } = await response.json();

    expect(body.unreadTotal).toBe(1); // the reply only — the failure is pre-read
    expect(body.households).toEqual([{ referralId, sent: false, messageCount: 2, unreadCount: 1 }]);
  });
});

describe('the thread and staff replies', () => {
  it('shows both directions in order and marks the thread read on request', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-1'));
    await testApp.request(`${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });
    await testApp.request(`${API_PREFIX}/webhooks/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: '07700 900123', content: 'Running late', messageid: 'p-1' }),
    });

    const threadResponse = await testApp.request(
      `${API_PREFIX}/referrals/${referralId}/sms-messages`,
      {
        headers: authHeaders(accessToken),
      },
    );
    const thread: { messages: { kind: string; readAt: string | null }[] } =
      await threadResponse.json();

    expect(thread.messages.map((m) => m.kind)).toEqual(['reminder', 'household_reply']);
    // GET is read-only: the reply is still unread until the mark-read action runs.
    expect(thread.messages[1]?.readAt).toBeNull();

    const markRead = await testApp.request(
      `${API_PREFIX}/referrals/${referralId}/sms-messages/read`,
      {
        method: 'POST',
        headers: authHeaders(accessToken),
      },
    );
    expect(markRead.status).toBe(204);

    const rows = await db.select().from(smsMessages).where(eq(smsMessages.referralId, referralId));
    const reply = rows.find((row) => row.kind === 'household_reply');
    expect(reply?.readAt).not.toBeNull();
  });

  it('lets staff reply, recording it against the referral', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('reply-1'));

    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    const response = await testApp.request(`${API_PREFIX}/referrals/${referralId}/sms-messages`, {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({ body: 'We can still come to you' }),
    });

    expect(response.status).toBe(201);
    const body: { kind: string; body: string } = await response.json();
    expect(body).toMatchObject({ kind: 'staff_reply', body: 'We can still come to you' });
  });

  it('refuses a staff reply the provider could not send, and writes nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));

    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world);

    const response = await testApp.request(`${API_PREFIX}/referrals/${referralId}/sms-messages`, {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({ body: 'We can still come to you' }),
    });

    expect(response.status).toBe(422);
    expect(await db.select().from(smsMessages)).toHaveLength(0);
  });

  it('a team lead may read and reply on a referral', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    const { id: referralId } = await submitReferral(testApp, world);

    const { accessToken: leadToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const readResponse = await testApp.request(
      `${API_PREFIX}/referrals/${referralId}/sms-messages`,
      {
        headers: authHeaders(leadToken),
      },
    );
    expect(readResponse.status).toBe(200);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('reply-1'));
    const replyResponse = await testApp.request(
      `${API_PREFIX}/referrals/${referralId}/sms-messages`,
      {
        method: 'POST',
        headers: json(leadToken),
        body: JSON.stringify({ body: 'Understood, see you then' }),
      },
    );
    expect(replyResponse.status).toBe(201);
  });

  it('a team lead may not see loose replies', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: leadToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await testApp.request(`${API_PREFIX}/sms-messages/unmatched`, {
      headers: authHeaders(leadToken),
    });

    expect(response.status).toBe(403);
  });
});

describe('the inbound webhook', () => {
  async function postWebhook(
    testApp: TestApp,
    body: Record<string, unknown>,
    headers: Record<string, string> = basicAuth(WEBHOOK_SECRET),
  ): Promise<Response> {
    return testApp.request(`${API_PREFIX}/webhooks/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('matches a reply to the referral for the soonest session still to come', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    // A later session with the same reason/referrer set up.
    const laterSessionId = await createSession(testApp, accessToken, { sessionDate: '2026-08-18' });

    const { id: soonerReferralId } = await submitReferral(testApp, world, {
      refereePhone: '07700 900999',
    });
    await submitReferral(
      testApp,
      { ...world, sessionId: laterSessionId },
      { refereePhone: '07700 900999' },
    );

    const response = await postWebhook(testApp, {
      source: '07700900999',
      content: 'Can you confirm the time?',
      messageid: 'match-1',
    });
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.providerMessageId, 'match-1'));
    expect(row?.referralId).toBe(soonerReferralId);
  });

  it('matches a reply whose E.164 source matches a referral phone stored in local format', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    const { id: referralId } = await submitReferral(testApp, world, {
      refereePhone: '07700 900123',
    });

    const response = await postWebhook(testApp, {
      source: '+447700900123',
      content: 'Can you confirm the time?',
      messageid: 'match-e164-1',
    });
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.providerMessageId, 'match-e164-1'));
    expect(row?.referralId).toBe(referralId);
  });

  it('matches a reply whose local-format source matches a referral phone stored as E.164', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    const { id: referralId } = await submitReferral(testApp, world, {
      refereePhone: '+447700900456',
    });

    const response = await postWebhook(testApp, {
      source: '07700 900456',
      content: 'Can you confirm the time?',
      messageid: 'match-local-1',
    });
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.providerMessageId, 'match-local-1'));
    expect(row?.referralId).toBe(referralId);
  });

  it('does not match a session that has already happened', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });

    const pastSessionId = await createSession(testApp, accessToken, { sessionDate: '2026-07-20' });
    const world = await setUpReferralWorld(testApp, accessToken);
    // The public submission cutoff now refuses a session that has already
    // passed — which this one deliberately has, relative to `testApp`'s own
    // `NOW`. Submitted instead through a second app instance, clocked while
    // the session was still in the future, sharing the same database.
    const submittingApp = buildTestApp({ clock: fixedClock('2026-07-15T09:00:00.000Z') });
    await submitReferral(
      submittingApp,
      { ...world, sessionId: pastSessionId },
      { refereePhone: '07700 900111' },
    );

    const response = await postWebhook(testApp, {
      source: '07700900111',
      content: 'Hello?',
      messageid: 'past-1',
    });
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.providerMessageId, 'past-1'));
    expect(row?.referralId).toBeNull(); // a loose reply, not matched to the past session
  });

  it('matches a reply that arrives after the session has started but on the day it runs', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });

    // Starts at 07:00 BST (06:00 UTC), well before `NOW` (09:00 UTC) — a
    // session already under way, not "still to come" by start time alone.
    // Deliveries running past their start time, and replies sent mid-session,
    // both need this to still count as a candidate.
    const todaySessionId = await createSession(testApp, accessToken, {
      sessionDate: '2026-08-04',
      startTime: '07:00',
    });
    const world = await setUpReferralWorld(testApp, accessToken);
    const submittingApp = buildTestApp({ clock: fixedClock('2026-08-01T09:00:00.000Z') });
    const { id: referralId } = await submitReferral(
      submittingApp,
      { ...world, sessionId: todaySessionId },
      { refereePhone: '07700 900333' },
    );

    const response = await postWebhook(testApp, {
      source: '07700900333',
      content: 'Running a bit late',
      messageid: 'today-1',
    });
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.providerMessageId, 'today-1'));
    expect(row?.referralId).toBe(referralId); // still open on the day it runs
  });

  it('does not match a reply once the session has been confirmed, even before its start time', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });

    // Starts at 11:00 BST (10:00 UTC), after `NOW` — signed off early anyway.
    const laterSessionId = await createSession(testApp, accessToken, {
      sessionDate: '2026-08-04',
      startTime: '11:00',
    });
    const world = await setUpReferralWorld(testApp, accessToken);
    const submittingApp = buildTestApp({ clock: fixedClock('2026-08-01T09:00:00.000Z') });
    await submitReferral(
      submittingApp,
      { ...world, sessionId: laterSessionId },
      { refereePhone: '07700 900444' },
    );
    await confirmSession(testApp, accessToken, laterSessionId);

    const response = await postWebhook(testApp, {
      source: '07700900444',
      content: 'Can I still come?',
      messageid: 'confirmed-1',
    });
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.providerMessageId, 'confirmed-1'));
    expect(row?.referralId).toBeNull(); // signed off — a loose reply now
  });

  it('keeps a reply from an unknown number as a loose reply', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });

    const response = await postWebhook(testApp, {
      source: '07700 900000',
      content: 'Who is this?',
      messageid: 'loose-1',
    });
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.providerMessageId, 'loose-1'));
    expect(row?.referralId).toBeNull();
    expect(row?.readAt).toBeNull(); // a household_reply is the one kind that starts unread
  });

  it('writes one row when the same provider message id arrives twice, and still returns 200', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });

    const first = await postWebhook(testApp, {
      source: '07700 900222',
      content: 'Retry me',
      messageid: 'dupe-1',
    });
    expect(first.status).toBe(200);

    const second = await postWebhook(testApp, {
      source: '07700 900222',
      content: 'Retry me',
      messageid: 'dupe-1',
    });
    expect(second.status).toBe(200);

    const rows = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.providerMessageId, 'dupe-1'));
    expect(rows).toHaveLength(1);
  });

  it('refuses a request with the wrong webhook credentials', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });

    const response = await postWebhook(
      testApp,
      { source: '07700 900222', content: 'hi' },
      basicAuth('wrong:secret'),
    );
    expect(response.status).toBe(401);
    expect(await db.select().from(smsMessages)).toHaveLength(0);
  });

  it('accepts a lower-case scheme name, because HTTP says schemes are case-insensitive', async () => {
    // A provider that sends `basic` rather than `Basic` would otherwise have
    // every reply rejected — and a rejected webhook is a household's reply
    // lost, silently, because the failure is on their side of the call.
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });

    const response = await postWebhook(
      testApp,
      { source: '07700 900222', content: 'hi' },
      { authorization: `basic ${btoa(WEBHOOK_SECRET)}` },
    );

    expect(response.status).toBe(200);
    expect(await db.select().from(smsMessages)).toHaveLength(1);
  });

  it('refuses a malformed authorization header', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });

    for (const authorization of [
      'Basic',
      'Bearer sometoken',
      `Basic ${btoa('a')} extra`,
      'Basic !',
    ]) {
      const response = await postWebhook(
        testApp,
        { source: '07700 900222', content: 'hi' },
        { authorization },
      );
      expect(response.status, authorization).toBe(401);
    }

    expect(await db.select().from(smsMessages)).toHaveLength(0);
  });

  it('refuses a request with no webhook credentials at all', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });

    const response = await postWebhook(testApp, { source: '07700 900222', content: 'hi' }, {});
    expect(response.status).toBe(401);
  });

  it('is not gated when no webhook secret is configured, so development still works', async () => {
    const testApp = buildSmsTestApp();

    const response = await postWebhook(testApp, { source: '07700 900222', content: 'hi' }, {});
    expect(response.status).toBe(200);
  });
});

describe('loose replies, admin only', () => {
  it('lists unmatched replies and lets an admin mark one read', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });

    await testApp.request(`${API_PREFIX}/webhooks/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...basicAuth(WEBHOOK_SECRET) },
      body: JSON.stringify({ source: '07700 900333', content: 'Hello', messageid: 'loose-list-1' }),
    });

    const list = await testApp.request(`${API_PREFIX}/sms-messages/unmatched`, {
      headers: authHeaders(accessToken),
    });
    const body: { messages: { id: string; readAt: string | null }[] } = await list.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.readAt).toBeNull();

    const messageId = body.messages[0]?.id ?? '';
    const markRead = await testApp.request(`${API_PREFIX}/sms-messages/${messageId}/read`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });
    expect(markRead.status).toBe(200);
    const markedMessage: { readAt: string | null } = await markRead.json();
    expect(markedMessage.readAt).not.toBeNull();
  });
});

/** The shape `toInboxMessageResponse` produces — see `sms.mapper.ts`. */
interface InboxMessage {
  readonly id: string;
  readonly referralId: string | null;
  readonly kind: string;
  readonly body: string;
  readonly occurredAt: string;
  readonly readAt: string | null;
  readonly location: 'unmatched' | 'active_session' | 'closed_session';
  readonly session: { id: string; sessionDate: string; startTime: string; status: string } | null;
  readonly phone: string | null;
}

/** Posts a household reply that the webhook will match to whatever referral holds `phone`. */
async function postReply(testApp: TestApp, phone: string, content = 'Hello'): Promise<Response> {
  return testApp.request(`${API_PREFIX}/webhooks/sms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: phone, content, messageid: crypto.randomUUID() }),
  });
}

async function confirmSession(testApp: TestApp, token: string, sessionId: string): Promise<void> {
  const response = await testApp.request(`${API_PREFIX}/sessions/${sessionId}/confirm`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
}

async function cancelSession(testApp: TestApp, token: string, sessionId: string): Promise<void> {
  const response = await testApp.request(`${API_PREFIX}/sessions/${sessionId}/cancel`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
}

async function attentionTotal(testApp: TestApp, token: string): Promise<unknown> {
  const response = await testApp.request(`${API_PREFIX}/sms-messages/attention-summary`, {
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe('the administrator attention summary', () => {
  it('is admin only, refusing a team lead', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: leadToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await testApp.request(`${API_PREFIX}/sms-messages/attention-summary`, {
      headers: authHeaders(leadToken),
    });
    expect(response.status).toBe(403);
  });

  it('returns unreadTotal and nothing else, leaking no message content', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });

    await postReply(testApp, '07700 900999', 'Something personal');

    const response = await testApp.request(`${API_PREFIX}/sms-messages/attention-summary`, {
      headers: authHeaders(adminToken),
    });
    expect(response.status).toBe(200);
    // toEqual, not toMatchObject: this is a leakage check, so an extra field
    // must fail it as loudly as a missing one.
    expect(await response.json()).toEqual({ unreadTotal: 1 });
  });

  it('does not count an unread reply while its session is still planned', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, world);
    await postReply(testApp, '07700 900123');

    expect(await attentionTotal(testApp, adminToken)).toEqual({ unreadTotal: 0 });
  });

  it('counts an unread reply once its session has been confirmed', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, world);
    await postReply(testApp, '07700 900123');

    await confirmSession(testApp, adminToken, world.sessionId);

    expect(await attentionTotal(testApp, adminToken)).toEqual({ unreadTotal: 1 });
  });

  it('counts an unread reply once its session has been cancelled', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    const { id: referralId } = await submitReferral(testApp, world);
    await postReply(testApp, '07700 900123');

    // A session cannot be cancelled while a referral still holds a place on
    // it, so the household is cancelled first — the sms row's session
    // snapshot is independent of that and is untouched by it.
    const cancelReferral = await testApp.request(`${API_PREFIX}/referrals/${referralId}/cancel`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    expect(cancelReferral.status).toBe(200);

    await cancelSession(testApp, adminToken, world.sessionId);

    expect(await attentionTotal(testApp, adminToken)).toEqual({ unreadTotal: 1 });
  });

  it('counts an unread loose reply with no session behind it at all', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });

    await postReply(testApp, '07700 900999', 'Who is this?');

    expect(await attentionTotal(testApp, adminToken)).toEqual({ unreadTotal: 1 });
  });

  it('does not count a reply that has already been read, even on a closed session', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, world);
    await postReply(testApp, '07700 900123');
    await confirmSession(testApp, adminToken, world.sessionId);

    const [reply] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.kind, 'household_reply'));
    const markRead = await testApp.request(`${API_PREFIX}/sms-messages/${reply?.id ?? ''}/read`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    expect(markRead.status).toBe(200);

    expect(await attentionTotal(testApp, adminToken)).toEqual({ unreadTotal: 0 });
  });

  it('never counts a failure row, even on a closed session, because a failure always arrives read', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    // No phone on file: `sms-reminders` records this as a `failure` row.
    await submitReferral(testApp, world, { refereePhone: undefined });

    const remind = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      {
        method: 'POST',
        headers: authHeaders(adminToken),
      },
    );
    expect(await remind.json()).toMatchObject({ reminded: 0, failed: 1 });

    await confirmSession(testApp, adminToken, world.sessionId);

    expect(await attentionTotal(testApp, adminToken)).toEqual({ unreadTotal: 0 });
  });
});

describe('the administrator inbox', () => {
  it('is admin only, refusing a team lead', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: leadToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await testApp.request(`${API_PREFIX}/sms-messages`, {
      headers: authHeaders(leadToken),
    });
    expect(response.status).toBe(403);
  });

  it('lists every message newest first, with location, session and phone set per row', async () => {
    const mainApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(mainApp, { email: 'admin@foodbank.org' });

    // One world (one reason, one referrer); a second session for the closed case.
    const world = await setUpReferralWorld(mainApp, adminToken);
    await submitReferral(mainApp, world, { refereePhone: '07700 900111' });

    const closedSessionId = await createSession(mainApp, adminToken, { sessionDate: '2026-08-18' });
    await submitReferral(
      mainApp,
      { ...world, sessionId: closedSessionId },
      { refereePhone: '07700 900222' },
    );

    // Distinct clocks so the three messages land at three distinct instants,
    // sharing the same underlying database as `mainApp`.
    const earlyApp = buildTestApp({ clock: fixedClock('2026-08-01T09:00:00.000Z') });
    const middleApp = buildTestApp({ clock: fixedClock('2026-08-02T09:00:00.000Z') });
    const lateApp = buildTestApp({ clock: fixedClock(NOW) });

    await postReply(earlyApp, '07700 900333', 'Who is this?'); // oldest: unmatched
    await postReply(middleApp, '07700 900111', 'Running late'); // middle: active session
    await postReply(lateApp, '07700 900222', 'Thank you'); // newest: soon-to-close session

    await confirmSession(lateApp, adminToken, closedSessionId);

    const response = await mainApp.request(`${API_PREFIX}/sms-messages`, {
      headers: authHeaders(adminToken),
    });
    expect(response.status).toBe(200);
    const body: { messages: InboxMessage[] } = await response.json();

    expect(body.messages.map((m) => m.body)).toEqual(['Thank you', 'Running late', 'Who is this?']);
    const [closed, active, unmatched] = body.messages;

    expect(closed).toMatchObject({
      location: 'closed_session',
      phone: '+447700900222',
      session: {
        id: closedSessionId,
        sessionDate: '2026-08-18',
        startTime: '10:00',
        status: 'confirmed',
      },
    });

    expect(active).toMatchObject({
      location: 'active_session',
      phone: '+447700900111',
      session: { id: world.sessionId, status: 'planned' },
    });

    expect(unmatched).toMatchObject({
      location: 'unmatched',
      session: null,
      phone: '+447700900333',
    });
  });

  it('omits a phone number that was only ever reminded, and returns a qualifying number whole, reminder included', async () => {
    const mainApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(mainApp, { email: 'admin@foodbank.org' });

    const world = await setUpReferralWorld(mainApp, adminToken);
    await submitReferral(mainApp, world, { refereePhone: '07700 900111' }); // will reply

    const reminderOnlySessionId = await createSession(mainApp, adminToken, {
      sessionDate: '2026-08-25',
    });
    await submitReferral(
      mainApp,
      { ...world, sessionId: reminderOnlySessionId },
      { refereePhone: '07700 900444' }, // reminded, never heard from
    );

    // Each reminder needs its own provider message id — the unique index on
    // `providerMessageId` would otherwise reject the second insert.
    let providerCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(providerSuccess(`prov-${String(++providerCalls)}`)),
    );
    for (const sessionId of [world.sessionId, reminderOnlySessionId]) {
      const remind = await mainApp.request(`${API_PREFIX}/sessions/${sessionId}/sms-reminders`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      expect(await remind.json()).toMatchObject({ reminded: 1, failed: 0 });
    }

    // Strictly after the reminders, so it never ties with them on `occurredAt`.
    const replyApp = buildTestApp({ clock: fixedClock('2026-08-04T09:00:01.000Z') });
    await postReply(replyApp, '07700 900111', 'Running late');

    const response = await mainApp.request(`${API_PREFIX}/sms-messages`, {
      headers: authHeaders(adminToken),
    });
    expect(response.status).toBe(200);
    const body: { messages: InboxMessage[] } = await response.json();

    // 900444 was only ever reminded — absent entirely, reminder and all.
    expect(body.messages.some((m) => m.phone === '+447700900444')).toBe(false);

    // 900111 qualifies (it replied), so its own reminder comes back too.
    const forQualifying = body.messages.filter((m) => m.phone === '+447700900111');
    expect(forQualifying.map((m) => m.kind).sort()).toEqual(['household_reply', 'reminder']);

    // Newest first, robust to the two reminders sharing a timestamp.
    const occurredAtValues = body.messages.map((m) => m.occurredAt);
    expect(occurredAtValues).toEqual([...occurredAtValues].sort().reverse());
  });

  it('never treats two households with no phone on file as the same thread', async () => {
    // Both referrals write their failure row with the same `phone: ''`
    // sentinel — this proves that never surfaces as a shared, groupable
    // "phone number" in the response.
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });

    const world = await setUpReferralWorld(testApp, adminToken);
    const { id: firstReferralId } = await submitReferral(testApp, world, {
      refereePhone: undefined,
    });

    const secondSessionId = await createSession(testApp, adminToken, { sessionDate: '2026-08-18' });
    const { id: secondReferralId } = await submitReferral(
      testApp,
      { ...world, sessionId: secondSessionId },
      { refereePhone: undefined },
    );

    for (const sessionId of [world.sessionId, secondSessionId]) {
      const remind = await testApp.request(`${API_PREFIX}/sessions/${sessionId}/sms-reminders`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      expect(await remind.json()).toMatchObject({ reminded: 0, failed: 1 });
    }

    const response = await testApp.request(`${API_PREFIX}/sms-messages`, {
      headers: authHeaders(adminToken),
    });
    expect(response.status).toBe(200);
    const body: { messages: InboxMessage[] } = await response.json();

    expect(body.messages).toHaveLength(2);
    expect(body.messages.every((m) => m.phone === null)).toBe(true);
    expect(body.messages.map((m) => m.referralId).sort()).toEqual(
      [firstReferralId, secondReferralId].sort(),
    );
  });
});

describe('the sessionId snapshot survives a referral move', () => {
  it('keeps reflecting the session a reply actually arrived on, not wherever the referral sits now', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const worldA = await setUpReferralWorld(testApp, adminToken);
    const { id: referralId } = await submitReferral(testApp, worldA);

    const sessionB = await createSession(testApp, adminToken, { sessionDate: '2026-08-18' });

    await postReply(testApp, '07700 900123', 'See you then');

    const [beforeMove] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.kind, 'household_reply'));
    expect(beforeMove?.sessionId).toBe(worldA.sessionId);

    // Move the referral away while session A is still open.
    const move = await testApp.request(`${API_PREFIX}/referrals/${referralId}`, {
      method: 'PATCH',
      headers: json(adminToken),
      body: JSON.stringify({ sessionId: sessionB }),
    });
    expect(move.status).toBe(200);

    const [afterMove] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.kind, 'household_reply'));
    expect(afterMove?.sessionId).toBe(worldA.sessionId); // untouched by the move

    // Session A closes; session B — where the referral now actually sits — does not.
    await confirmSession(testApp, adminToken, worldA.sessionId);

    const response = await testApp.request(`${API_PREFIX}/sms-messages`, {
      headers: authHeaders(adminToken),
    });
    const body: { messages: InboxMessage[] } = await response.json();
    const message = body.messages.find((m) => m.body === 'See you then');

    expect(message).toMatchObject({
      location: 'closed_session',
      session: { id: worldA.sessionId, status: 'confirmed' },
    });

    // The proof that matters: it counts as a closed-session item, which it
    // could only do by keying off the snapshot — a live join through the
    // referral would find session B, still `planned`, and not count it at all.
    expect(await attentionTotal(testApp, adminToken)).toEqual({ unreadTotal: 1 });
  });
});

describe('marking one inbox message read', () => {
  it('marks an unread reply on a closed session read, returning it with readAt set', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, world);
    await postReply(testApp, '07700 900123');
    await confirmSession(testApp, adminToken, world.sessionId);

    const [reply] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.kind, 'household_reply'));
    const response = await testApp.request(`${API_PREFIX}/sms-messages/${reply?.id ?? ''}/read`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });

    expect(response.status).toBe(200);
    const body: { readAt: string | null } = await response.json();
    expect(body.readAt).not.toBeNull();
  });

  it('is idempotent: reading the same message again reports the same readAt rather than erroring', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, world);
    await postReply(testApp, '07700 900123');
    await confirmSession(testApp, adminToken, world.sessionId);

    const [reply] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.kind, 'household_reply'));
    const messageId = reply?.id ?? '';

    const first = await testApp.request(`${API_PREFIX}/sms-messages/${messageId}/read`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    const firstBody: { readAt: string | null } = await first.json();

    const second = await testApp.request(`${API_PREFIX}/sms-messages/${messageId}/read`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    expect(second.status).toBe(200);
    const secondBody: { readAt: string | null } = await second.json();

    expect(secondBody.readAt).not.toBeNull();
    expect(secondBody.readAt).toBe(firstBody.readAt);
  });

  it('does not mark a different unread reply on the same session read', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, world, { refereePhone: '07700 900111' });
    await submitReferral(testApp, world, { refereePhone: '07700 900222' });
    await postReply(testApp, '07700 900111', 'First household');
    await postReply(testApp, '07700 900222', 'Second household');
    await confirmSession(testApp, adminToken, world.sessionId);

    expect(await attentionTotal(testApp, adminToken)).toEqual({ unreadTotal: 2 });

    const rows = await db.select().from(smsMessages).where(eq(smsMessages.kind, 'household_reply'));
    const [first, second] = rows;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const markRead = await testApp.request(`${API_PREFIX}/sms-messages/${first?.id ?? ''}/read`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    expect(markRead.status).toBe(200);

    // Exactly one cleared — the count drops by one, not to zero.
    expect(await attentionTotal(testApp, adminToken)).toEqual({ unreadTotal: 1 });

    const [untouched] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.id, second?.id ?? ''));
    expect(untouched?.readAt).toBeNull();
  });

  it('refuses a reminder id, a staff-reply id and a nonexistent id, matching the old NotFoundError shape', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    const { id: referralId } = await submitReferral(testApp, world);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-1'));
    await testApp.request(`${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    const staffReply = await testApp.request(`${API_PREFIX}/referrals/${referralId}/sms-messages`, {
      method: 'POST',
      headers: json(adminToken),
      body: JSON.stringify({ body: 'Thanks for letting us know' }),
    });
    const staffReplyBody: { id: string } = await staffReply.json();

    const [reminder] = await db.select().from(smsMessages).where(eq(smsMessages.kind, 'reminder'));

    for (const id of [reminder?.id ?? '', staffReplyBody.id, crypto.randomUUID()]) {
      const response = await testApp.request(`${API_PREFIX}/sms-messages/${id}/read`, {
        method: 'POST',
        headers: authHeaders(adminToken),
      });
      expect(response.status, id).toBe(404);
    }
  });

  it('refuses to mark an active-session reply read, leaving it and the session unread count untouched', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, world);
    // The session stays `planned` — postReply snapshots it as an active_session message.
    await postReply(testApp, '07700 900123');

    const [reply] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.kind, 'household_reply'));

    const response = await testApp.request(`${API_PREFIX}/sms-messages/${reply?.id ?? ''}/read`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    expect(response.status).toBe(404);

    const summary = await testApp.request(`${API_PREFIX}/sessions/${world.sessionId}/sms-summary`, {
      headers: authHeaders(adminToken),
    });
    const body: { unreadTotal: number; households: { unreadCount: number }[] } =
      await summary.json();
    expect(body.unreadTotal).toBe(1);
    expect(body.households[0]?.unreadCount).toBe(1);

    const [stillUnread] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.id, reply?.id ?? ''));
    expect(stillUnread?.readAt).toBeNull(); // the refused call had zero effect
  });

  it('does not clear an active session thread, or its sms-summary count, when a closed-session message is cleared', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });

    const activeWorld = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, activeWorld, { refereePhone: '07700 900111' });
    await postReply(testApp, '07700 900111', 'Still coming');

    const closedSessionId = await createSession(testApp, adminToken, { sessionDate: '2026-08-18' });
    await submitReferral(
      testApp,
      { ...activeWorld, sessionId: closedSessionId },
      { refereePhone: '07700 900222' },
    );
    await postReply(testApp, '07700 900222', 'Thanks for the reminder');
    await confirmSession(testApp, adminToken, closedSessionId);

    const [closedMessage] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.sessionId, closedSessionId));
    const markRead = await testApp.request(
      `${API_PREFIX}/sms-messages/${closedMessage?.id ?? ''}/read`,
      {
        method: 'POST',
        headers: authHeaders(adminToken),
      },
    );
    expect(markRead.status).toBe(200);

    const summary = await testApp.request(
      `${API_PREFIX}/sessions/${activeWorld.sessionId}/sms-summary`,
      { headers: authHeaders(adminToken) },
    );
    const body: { unreadTotal: number } = await summary.json();
    expect(body.unreadTotal).toBe(1); // untouched by clearing the unrelated closed-session item
  });
});

/** `toInboxMessageResponse`'s `SmsCandidateParcel` shape — admin inbox only. */
interface CandidateParcel {
  readonly referralId: string;
  readonly sessionId: string;
  readonly sessionDate: string;
  readonly startTime: string;
}

/** `InboxMessage` plus the fields new to `referrer_reply`. */
interface ReferrerInboxMessage extends InboxMessage {
  readonly recipientRole: 'referee' | 'referrer' | null;
  readonly candidateParcels?: CandidateParcel[];
}

describe('referrer_collect: parcel SMS routes to the referrer, not the referee', () => {
  it('sends a referrer_collect reminder to the referrer phone, with the referrer wording, recipientRole referrer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-referrer-1'));

    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world, {
      collectionMethod: 'referrer_collect',
      referrerPhone: '07700 900555',
      refereePhone: '07700 900123',
    });

    const response = await testApp.request(
      `${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`,
      { method: 'POST', headers: authHeaders(accessToken) },
    );
    expect(await response.json()).toMatchObject({ reminded: 1, failed: 0 });

    const [session] = await db.select().from(sessions).where(eq(sessions.id, world.sessionId));
    if (session === undefined) throw new Error('session not found in test setup');
    const expectedReferrerBody = composeReferrerReminder(session, 'Jane Fieldsworth');

    const [row] = await db.select().from(smsMessages).where(eq(smsMessages.referralId, referralId));
    expect(row).toMatchObject({
      kind: 'reminder',
      phone: '+447700900555', // the referrer's number, never the referee's
      body: expectedReferrerBody,
      recipientRole: 'referrer',
    });

    // The referral's own thread, which the mapper also serves, agrees.
    const threadResponse = await testApp.request(
      `${API_PREFIX}/referrals/${referralId}/sms-messages`,
      { headers: authHeaders(accessToken) },
    );
    const thread: {
      messages: { phone: string; body: string; recipientRole: string | null }[];
    } = await threadResponse.json();
    expect(thread.messages[0]).toMatchObject({
      phone: '+447700900555',
      body: expectedReferrerBody,
      recipientRole: 'referrer',
    });
  });

  it('still sends an ordinary collection referral its own composed reminder to the referee, recipientRole referee', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-referee-1'));

    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world, {
      collectionMethod: 'collection',
      refereePhone: '07700 900123',
    });

    await testApp.request(`${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });

    const [session] = await db.select().from(sessions).where(eq(sessions.id, world.sessionId));
    if (session === undefined) throw new Error('session not found in test setup');
    const expectedBody = composeReminder(session, false, 'Alice');
    const referrerShapedBody = composeReferrerReminder(session, 'Jane Fieldsworth');

    const [row] = await db.select().from(smsMessages).where(eq(smsMessages.referralId, referralId));
    expect(row).toMatchObject({
      kind: 'reminder',
      phone: '+447700900123',
      body: expectedBody,
      recipientRole: 'referee',
    });
    // An ordinary collection referral's reminder is never referrer_collect-shaped.
    expect(row?.body).not.toBe(referrerShapedBody);
  });

  it('sends a staff reply on a referrer_collect thread to the referrer, the staff text verbatim, not the placeholder', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-staff-1'));

    const testApp = buildSmsTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id: referralId } = await submitReferral(testApp, world, {
      collectionMethod: 'referrer_collect',
      referrerPhone: '07700 900555',
      refereePhone: '07700 900123',
    });

    const response = await testApp.request(`${API_PREFIX}/referrals/${referralId}/sms-messages`, {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({ body: 'We can still come to you' }),
    });

    expect(response.status).toBe(201);
    const body: { phone: string; body: string; recipientRole: string | null } =
      await response.json();
    expect(body).toMatchObject({
      phone: '+447700900555',
      body: 'We can still come to you', // typed verbatim — only the recipient changes
      recipientRole: 'referrer',
    });
  });
});

describe('referrer_reply: inbound texts from a referrer collecting a parcel', () => {
  it('records an inbound text from a referrer with exactly one open referrer_collect referral, naming that one candidate', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    const { id: referralId } = await submitReferral(testApp, world, {
      collectionMethod: 'referrer_collect',
      referrerPhone: '07700 900555',
    });

    const webhookResponse = await postReply(
      testApp,
      '07700 900555',
      'Can I collect at 2pm instead?',
    );
    expect(webhookResponse.status).toBe(200);

    const response = await testApp.request(`${API_PREFIX}/sms-messages`, {
      headers: authHeaders(adminToken),
    });
    expect(response.status).toBe(200);
    const body: { messages: ReferrerInboxMessage[] } = await response.json();

    const referrerReply = body.messages.find((m) => m.kind === 'referrer_reply');
    expect(referrerReply).toMatchObject({ referralId: null, recipientRole: 'referrer' });
    expect(referrerReply?.candidateParcels).toEqual([
      { referralId, sessionId: world.sessionId, sessionDate: '2026-08-11', startTime: '10:00' },
    ]);
  });

  it('never collapses a referrer with multiple open referrer_collect referrals to one candidate', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    const { id: referralA } = await submitReferral(testApp, world, {
      collectionMethod: 'referrer_collect',
      referrerPhone: '07700 900555',
    });

    const secondSessionId = await createSession(testApp, adminToken, { sessionDate: '2026-08-18' });
    const { id: referralB } = await submitReferral(
      testApp,
      { ...world, sessionId: secondSessionId },
      { collectionMethod: 'referrer_collect', referrerPhone: '07700 900555' },
    );

    await postReply(testApp, '07700 900555', 'Which one is today?');

    const response = await testApp.request(`${API_PREFIX}/sms-messages`, {
      headers: authHeaders(adminToken),
    });
    const body: { messages: ReferrerInboxMessage[] } = await response.json();

    // One text in, one row — never auto-split into two messages either.
    const referrerReplies = body.messages.filter((m) => m.kind === 'referrer_reply');
    expect(referrerReplies).toHaveLength(1);

    const candidateIds = (referrerReplies[0]?.candidateParcels ?? [])
      .map((c) => c.referralId)
      .sort();
    expect(candidateIds).toEqual([referralA, referralB].sort());
  });

  it('excludes a cancelled referrer_collect referral from a referrer candidate list', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    const { id: stillOpen } = await submitReferral(testApp, world, {
      collectionMethod: 'referrer_collect',
      referrerPhone: '07700 900555',
    });

    const secondSessionId = await createSession(testApp, adminToken, { sessionDate: '2026-08-18' });
    const { id: toCancel } = await submitReferral(
      testApp,
      { ...world, sessionId: secondSessionId },
      { collectionMethod: 'referrer_collect', referrerPhone: '07700 900555' },
    );
    const cancelResponse = await testApp.request(`${API_PREFIX}/referrals/${toCancel}/cancel`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    expect(cancelResponse.status).toBe(200);

    await postReply(testApp, '07700 900555', 'Still coming for the other one');

    const response = await testApp.request(`${API_PREFIX}/sms-messages`, {
      headers: authHeaders(adminToken),
    });
    const body: { messages: ReferrerInboxMessage[] } = await response.json();
    const referrerReply = body.messages.find((m) => m.kind === 'referrer_reply');

    expect(referrerReply?.candidateParcels).toEqual([
      {
        referralId: stillOpen,
        sessionId: world.sessionId,
        sessionDate: '2026-08-11',
        startTime: '10:00',
      },
    ]);
  });

  it("does not appear on the referral's own thread, even though it was prompted by that referral's referrer number", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerSuccess('prov-thread-1'));

    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    const { id: referralId } = await submitReferral(testApp, world, {
      collectionMethod: 'referrer_collect',
      referrerPhone: '07700 900555',
    });

    await testApp.request(`${API_PREFIX}/sessions/${world.sessionId}/sms-reminders`, {
      method: 'POST',
      headers: authHeaders(adminToken),
    });
    await postReply(testApp, '07700 900555', 'Which day again?');

    const threadResponse = await testApp.request(
      `${API_PREFIX}/referrals/${referralId}/sms-messages`,
      { headers: authHeaders(adminToken) },
    );
    const thread: { messages: { kind: string }[] } = await threadResponse.json();

    // Only the reminder this referral was itself sent. The referrer_reply
    // always has referralId: null, so it structurally cannot be here — this
    // proves it, rather than asserting on the mapper's allowlist alone.
    expect(thread.messages.map((m) => m.kind)).toEqual(['reminder']);
  });

  it('still matches an ordinary referee reply to its own referral when an unrelated referrer_collect referral exists', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);

    // An unrelated referrer_collect referral in the same world — proves
    // referrer matching runs first, finds nothing for this sender, and
    // correctly falls through to the ordinary household match rather than
    // producing a loose or referrer_reply row instead.
    await submitReferral(testApp, world, {
      collectionMethod: 'referrer_collect',
      referrerPhone: '07700 900555',
      refereePhone: '07700 900556',
    });
    const { id: ordinaryReferralId } = await submitReferral(testApp, world, {
      collectionMethod: 'collection',
      refereePhone: '07700 900123',
    });

    const response = await postReply(testApp, '07700 900123', 'Running late');
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.referralId, ordinaryReferralId));
    expect(row).toMatchObject({ kind: 'household_reply', recipientRole: 'referee' });

    const kinds = (await db.select().from(smsMessages)).map((m) => m.kind);
    expect(kinds).not.toContain('referrer_reply');
  });

  it("marks a referrer_reply read via POST /sms-messages/:id/read, which previously 404'd on anything but household_reply", async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, world, {
      collectionMethod: 'referrer_collect',
      referrerPhone: '07700 900555',
    });

    await postReply(testApp, '07700 900555', 'Can I collect early?');

    const [referrerReplyRow] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.kind, 'referrer_reply'));
    expect(referrerReplyRow?.readAt).toBeNull();

    const response = await testApp.request(
      `${API_PREFIX}/sms-messages/${referrerReplyRow?.id ?? ''}/read`,
      { method: 'POST', headers: authHeaders(adminToken) },
    );
    expect(response.status).toBe(200);
    const body: { readAt: string | null } = await response.json();
    expect(body.readAt).not.toBeNull();

    const [updated] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.id, referrerReplyRow?.id ?? ''));
    expect(updated?.readAt).not.toBeNull();
  });

  it('counts an unread referrer_reply in the administrator attention summary', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, world, {
      collectionMethod: 'referrer_collect',
      referrerPhone: '07700 900555',
    });

    await postReply(testApp, '07700 900555', 'On my way');

    expect(await attentionTotal(testApp, adminToken)).toEqual({ unreadTotal: 1 });
  });
});

describe('purging still works with the session snapshot column', () => {
  it('deletes a message with a non-null sessionId once past the retention window, same as before', async () => {
    const testApp = buildSmsTestApp();
    const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, adminToken);
    await submitReferral(testApp, world);
    await postReply(testApp, '07700 900123');

    const [beforeAging] = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.kind, 'household_reply'));
    expect(beforeAging?.sessionId).toBe(world.sessionId); // sanity: this is the column under test

    // Age it past the thirty-day retention window.
    await db
      .update(smsMessages)
      .set({ occurredAt: '2026-06-01T00:00:00.000Z' })
      .where(eq(smsMessages.id, beforeAging?.id ?? ''));

    const result = await purgeSmsMessages({
      db,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
    });

    expect(result.purged).toBe(1);
    expect(await db.select().from(smsMessages)).toHaveLength(0);
  });
});
