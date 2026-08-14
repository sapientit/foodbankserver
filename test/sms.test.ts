import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_PREFIX } from '../src/app.ts';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { smsMessages } from '../src/db/schema/sms.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
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

  it('does not match a session that has already happened', async () => {
    const testApp = buildSmsTestApp({ SMS_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });

    const pastSessionId = await createSession(testApp, accessToken, { sessionDate: '2026-07-20' });
    const world = await setUpReferralWorld(testApp, accessToken);
    await submitReferral(
      testApp,
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
