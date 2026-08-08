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
  submitReferral,
  UNKNOWN_REFERRER,
  type ReferralWorld,
} from './helpers/referral-fixtures.ts';

/**
 * The listener sheet: the one place a team leader sees why a household was
 * referred.
 *
 * It is the most sensitive thing the system produces, so these tests are as
 * much about what it does **not** carry as what it does.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

interface Household {
  referralId: string;
  refereeFirstName: string | null;
  refereeSurname: string | null;
  reason: string | null;
  needsFuelHelp: boolean;
  answers: Record<string, unknown>;
}

async function adminWorld(): Promise<{
  testApp: TestApp;
  token: string;
  world: ReferralWorld;
}> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const world = await setUpReferralWorld(testApp, accessToken);
  return { testApp, token: accessToken, world };
}

async function readSheet(testApp: TestApp, token: string, sessionId: string) {
  const response = await testApp.request(`/api/v1/sessions/${sessionId}/listener-sheet`, {
    headers: authHeaders(token),
  });
  const body: { sessionId?: string; households?: Household[] } = await response.json();
  return { status: response.status, ...body };
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

describe('the listener sheet', () => {
  it('carries the name, the reason, the fuel flag and the answers', async () => {
    const { testApp, token, world } = await adminWorld();
    await submitReferral(testApp, world, {
      needsFuelHelp: true,
      answers: { 'Cause Details': 'Landlord sold the house', Dietary: 'no pork' },
    });

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.status).toBe(200);
    expect(sheet.households).toHaveLength(1);
    expect(sheet.households?.[0]).toEqual({
      referralId: expect.any(String),
      refereeFirstName: 'Alice',
      refereeSurname: 'Wintergreen',
      reason: 'Benefit delay',
      needsFuelHelp: true,
      // The whole map. **Cause Details is extracted by the client**, because
      // the client owns the form and the server holds no definition of it.
      answers: { 'Cause Details': 'Landlord sold the house', Dietary: 'no pork' },
    });
  });

  it('is readable by a team leader, which is the whole point of it', async () => {
    const { testApp, token, world } = await adminWorld();
    await submitReferral(testApp, world);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const sheet = await readSheet(lead, accessToken, world.sessionId);

    expect(sheet.status).toBe(200);
    expect(sheet.households?.[0]?.reason).toBe('Benefit delay');
    expect(token).toBeDefined();
  });

  it('still withholds the reason from a team leader everywhere else', async () => {
    // The listener sheet is an exception carved out of the rule, not the rule
    // being dropped. If this ever fails, the exception has leaked.
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await lead.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(accessToken),
    });
    const referral: Record<string, unknown> = await response.json();

    expect(referral).not.toHaveProperty('reasonId');
    expect(token).toBeDefined();
  });

  it('lists a household still awaiting review, because they may well turn up', async () => {
    const { testApp, token, world } = await adminWorld();
    await submitReferral(testApp, world, UNKNOWN_REFERRER);

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.households).toHaveLength(1);
  });

  it('lists a household whose referral has been read, exactly as it lists an unread one', async () => {
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world);

    const marked = await testApp.request(`/api/v1/referrals/${id}/review`, {
      method: 'POST',
      headers: json(token),
    });
    expect(marked.status).toBe(200);

    const sheet = await readSheet(testApp, token, world.sessionId);

    // Reading a referral is paperwork. The household is still coming, and a
    // listener with no line for them has nothing to work from.
    expect(sheet.households?.map((household) => household.referralId)).toEqual([id]);
  });

  it('leaves out a household that is not coming', async () => {
    // Handing a listener the name and the crisis of somebody who cancelled, or
    // whom the food bank turned away, is the harm this endpoint has to avoid.
    const { testApp, token, world } = await adminWorld();
    const coming = await submitReferral(testApp, world, {}, { clientIp: '203.0.113.1' });
    const cancelled = await submitReferral(testApp, world, {}, { clientIp: '203.0.113.2' });
    const rejected = await submitReferral(testApp, world, UNKNOWN_REFERRER, {
      clientIp: '203.0.113.3',
    });

    await testApp.request(`/api/v1/referrals/${cancelled.id}/cancel`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ reason: 'Found other help' }),
    });
    await testApp.request(`/api/v1/referrals/${rejected.id}/reject`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ comment: 'Not an authorised referrer' }),
    });

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.households?.map((household) => household.referralId)).toEqual([coming.id]);
  });

  it('leaves out a delivery, because nobody walks in for one', async () => {
    // A listener sheet is for the conversation that happens when somebody
    // arrives. A delivery household never arrives, so their name and their
    // crisis on a sheet carried round the hall exposes somebody who was never
    // going to be there.
    const { testApp, token, world } = await adminWorld();
    const collecting = await submitReferral(testApp, world, {}, { clientIp: '203.0.113.4' });
    await submitReferral(testApp, world, { isDelivery: true }, { clientIp: '203.0.113.5' });

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.households?.map((household) => household.referralId)).toEqual([collecting.id]);
  });

  it('carries no address, postcode or phone number', async () => {
    // A minimised sheet: a listener needs to know what happened, not where
    // somebody lives.
    const { testApp, token, world } = await adminWorld();
    await submitReferral(testApp, world);

    const sheet = await readSheet(testApp, token, world.sessionId);
    const household = sheet.households?.[0] as unknown as Record<string, unknown>;

    for (const field of [
      'refereeAddress',
      'refereePostcode',
      'refereePhone',
      'refereeDateOfBirth',
      'referrerName',
      'referrerEmail',
      'reviewComment',
    ]) {
      expect(household).not.toHaveProperty(field);
    }
  });

  it('survives a purged referral rather than falling over on the nulls', async () => {
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world);

    await db
      .update(referrals)
      .set({
        refereeFirstName: null,
        refereeSurname: null,
        answersJson: null,
        piiPurgedAt: NOW,
      })
      .where(eq(referrals.id, id));

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.status).toBe(200);
    expect(sheet.households?.[0]).toMatchObject({
      refereeFirstName: null,
      refereeSurname: null,
      answers: {},
    });
  });

  it('reports an unknown session as missing', async () => {
    const { testApp, token } = await adminWorld();

    const sheet = await readSheet(testApp, token, crypto.randomUUID());

    expect(sheet.status).toBe(404);
  });

  it('is refused without a token', async () => {
    const { testApp, world } = await adminWorld();

    const response = await testApp.request(`/api/v1/sessions/${world.sessionId}/listener-sheet`);

    expect(response.status).toBe(401);
  });
});
