import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createLogger } from '../src/core/log.ts';
import { createDatabase } from '../src/db/client.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { purgeReferralPii } from '../src/modules/jobs/purge-pii.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  setUpReferralWorld,
  submitReferral,
  UNKNOWN_REFERRER,
  type ReferralWorld,
} from './helpers/referral-fixtures.ts';
import {
  generatePickList,
  reviewEveryParcel,
  setUpPickingWorld,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

/**
 * `GET /sessions/{sessionId}/referral-details` — the contact list for the
 * day. `INITIAL_SPEC1.txt`, `#Reviewing a referral`, the team-leader
 * paragraph; `API.md`, "5h. Session referral details".
 *
 * A wider read than the listener sheet (address, postcode, phone, the
 * referrer's name and number) and deliberately open to a team leader, so
 * these tests are as much about the contrast with the listener sheet — what
 * it carries that the listener sheet does not, and what it withholds that
 * the listener sheet is the one place a team leader gets — as about the
 * endpoint on its own.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

let clientIpCounter = 0;
function nextClientIp(): string {
  clientIpCounter += 1;
  return `203.0.115.${String(clientIpCounter)}`;
}

interface ReferralDetailsHouseholdBody {
  readonly referralId: string;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly referrerName: string | null;
  readonly referrerPhone: string | null;
}

interface ReferralDetailsResponseBody {
  readonly sessionId: string;
  readonly sessionDate: string;
  readonly startTime: string;
  readonly location: string;
  readonly referrals: ReferralDetailsHouseholdBody[];
}

async function adminWorld(): Promise<{ testApp: TestApp; token: string; world: ReferralWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const world = await setUpReferralWorld(testApp, accessToken);
  return { testApp, token: accessToken, world };
}

async function readDetails(
  testApp: TestApp,
  token: string,
  sessionId: string,
): Promise<{ status: number; body: Partial<ReferralDetailsResponseBody> }> {
  const response = await testApp.request(`/api/v1/sessions/${sessionId}/referral-details`, {
    headers: authHeaders(token),
  });
  const body: Partial<ReferralDetailsResponseBody> = await response.json();
  return { status: response.status, body };
}

async function readListenerSheet(
  testApp: TestApp,
  token: string,
  sessionId: string,
): Promise<{ status: number; households: { referralId: string }[] }> {
  const response = await testApp.request(`/api/v1/sessions/${sessionId}/listener-sheet`, {
    headers: authHeaders(token),
  });
  const body: { households?: { referralId: string }[] } = await response.json();
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

describe('GET /sessions/{sessionId}/referral-details — role access', () => {
  it('is open to an admin and a team lead, refused to a fuel administrator, and refused without a token', async () => {
    const { testApp, token, world } = await adminWorld();
    await submitReferral(testApp, world, {}, { clientIp: nextClientIp() });

    const admin = await readDetails(testApp, token, world.sessionId);
    expect(admin.status).toBe(200);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: leadToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });
    const leadResponse = await lead.request(
      `/api/v1/sessions/${world.sessionId}/referral-details`,
      {
        headers: authHeaders(leadToken),
      },
    );
    expect(leadResponse.status).toBe(200);

    const fuel = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: fuelToken } = await devLogin(fuel, {
      email: 'fuel@foodbank.org',
      role: 'fuel_admin',
    });
    const fuelResponse = await fuel.request(
      `/api/v1/sessions/${world.sessionId}/referral-details`,
      {
        headers: authHeaders(fuelToken),
      },
    );
    expect(fuelResponse.status).toBe(403);

    const unauth = await testApp.request(`/api/v1/sessions/${world.sessionId}/referral-details`);
    expect(unauth.status).toBe(401);
  });
});

describe('the body carries the session and every household on it', () => {
  it('returns sessionId, sessionDate, startTime, location and the households', async () => {
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world, {}, { clientIp: nextClientIp() });

    const details = await readDetails(testApp, token, world.sessionId);

    expect(details.status).toBe(200);
    expect(details.body.sessionId).toBe(world.sessionId);
    expect(details.body.sessionDate).toBe('2026-08-11');
    expect(details.body.startTime).toBe('10:00');
    expect(details.body.location).toBe('Church Hall');
    expect(details.body.referrals?.map((referral) => referral.referralId)).toEqual([id]);
  });

  it('reports an unknown session as 404', async () => {
    const { testApp, token } = await adminWorld();

    const details = await readDetails(testApp, token, crypto.randomUUID());
    expect(details.status).toBe(404);
  });
});

describe('who is included', () => {
  it('includes pending_review, active and reviewed referrals, and excludes cancelled and rejected ones', async () => {
    const { testApp, token, world } = await adminWorld();

    const pending = await submitReferral(
      testApp,
      world,
      { ...UNKNOWN_REFERRER, refereeSurname: 'Pending' },
      { clientIp: nextClientIp() },
    );
    const active = await submitReferral(
      testApp,
      world,
      { refereeSurname: 'Active' },
      { clientIp: nextClientIp() },
    );
    const toBeReviewed = await submitReferral(
      testApp,
      world,
      { refereeSurname: 'Reviewed' },
      { clientIp: nextClientIp() },
    );
    const toBeCancelled = await submitReferral(
      testApp,
      world,
      { refereeSurname: 'Cancelled' },
      { clientIp: nextClientIp() },
    );
    const toBeRejected = await submitReferral(
      testApp,
      world,
      { ...UNKNOWN_REFERRER, refereeSurname: 'Rejected' },
      { clientIp: nextClientIp() },
    );

    await testApp.request(`/api/v1/referrals/${toBeReviewed.id}/review`, {
      method: 'POST',
      headers: json(token),
    });
    await testApp.request(`/api/v1/referrals/${toBeCancelled.id}/cancel`, {
      method: 'POST',
      headers: json(token),
    });
    await testApp.request(`/api/v1/referrals/${toBeRejected.id}/reject`, {
      method: 'POST',
      headers: json(token),
    });

    const details = await readDetails(testApp, token, world.sessionId);
    expect(details.body.referrals?.map((referral) => referral.referralId).sort()).toEqual(
      [pending.id, active.id, toBeReviewed.id].sort(),
    );
  });

  it('includes a delivery household — the deliberate difference from the listener sheet, which drops it', async () => {
    const { testApp, token, world } = await adminWorld();
    const collecting = await submitReferral(testApp, world, {}, { clientIp: nextClientIp() });
    const delivery = await submitReferral(
      testApp,
      world,
      { isDelivery: true },
      { clientIp: nextClientIp() },
    );

    const details = await readDetails(testApp, token, world.sessionId);
    expect(details.body.referrals?.map((referral) => referral.referralId).sort()).toEqual(
      [collecting.id, delivery.id].sort(),
    );

    // The contrast, made visible in the same test: the listener sheet drops
    // the same delivery household.
    const sheet = await readListenerSheet(testApp, token, world.sessionId);
    expect(sheet.households.map((household) => household.referralId)).toEqual([collecting.id]);
  });

  it('is ordered by surname, then first name', async () => {
    const { testApp, token, world } = await adminWorld();
    await submitReferral(
      testApp,
      world,
      { refereeFirstName: 'Zack', refereeSurname: 'Robinson' },
      { clientIp: nextClientIp() },
    );
    await submitReferral(
      testApp,
      world,
      { refereeFirstName: 'Amy', refereeSurname: 'Ashworth' },
      { clientIp: nextClientIp() },
    );
    await submitReferral(
      testApp,
      world,
      { refereeFirstName: 'Amy', refereeSurname: 'Robinson' },
      { clientIp: nextClientIp() },
    );

    const details = await readDetails(testApp, token, world.sessionId);
    expect(details.body.referrals?.map((referral) => referral.refereeSurname)).toEqual([
      'Ashworth',
      'Robinson',
      'Robinson',
    ]);
    expect(
      details.body.referrals?.map(
        (referral) => `${referral.refereeSurname ?? ''} ${referral.refereeFirstName ?? ''}`,
      ),
    ).toEqual(['Ashworth Amy', 'Robinson Amy', 'Robinson Zack']);
  });
});

describe('a purged household', () => {
  it('still appears, with nulls rather than being dropped', async () => {
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world, {}, { clientIp: nextClientIp() });

    await db
      .update(referrals)
      .set({ referredAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(referrals.id, id));
    await purgeReferralPii({
      db,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
      retentionDays: 365,
    });

    const details = await readDetails(testApp, token, world.sessionId);
    expect(details.status).toBe(200);
    expect(details.body.referrals?.[0]).toMatchObject({
      referralId: id,
      refereeFirstName: null,
      refereeSurname: null,
      refereeAddress: null,
      refereePostcode: null,
      refereePhone: null,
    });
  });
});

describe('the response allowlist', () => {
  it('carries refereeAddress, refereePostcode, refereePhone, referrerName and referrerPhone, and never carries date of birth, the reason, the answers, the review comment, referrerEmail, referrerOrganisation, or any parcel or line data — asserted on the raw response text', async () => {
    const testApp = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world: PickingWorld = await setUpPickingWorld(testApp, token);

    await testApp.request('/api/v1/stock/take', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        counts: [
          { stockItemId: world.stockItems.Beans, countedQuantity: 500 },
          { stockItemId: world.stockItems.Pasta, countedQuantity: 500 },
          { stockItemId: world.stockItems.Cereal, countedQuantity: 500 },
        ],
      }),
    });

    const { id } = await submitReferral(
      testApp,
      world,
      {
        ...UNKNOWN_REFERRER,
        refereeDateOfBirth: '1949-08-04',
        answers: { Dietary: 'Allergic to shellfish specifically' },
      },
      { clientIp: nextClientIp() },
    );
    await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ comment: 'Confidential referral note, admin eyes only' }),
    });

    // Give the session parcel and line data too, so their absence here is
    // proven against a session that actually has some, not an empty one.
    const pickList = await generatePickList(testApp, token, world.sessionId);
    await reviewEveryParcel(testApp, token, pickList.id);

    const response = await testApp.request(`/api/v1/sessions/${world.sessionId}/referral-details`, {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);
    const text = await response.text();

    // Present on purpose.
    expect(text).toContain('refereeAddress');
    expect(text).toContain('refereePostcode');
    expect(text).toContain('refereePhone');
    expect(text).toContain('referrerName');
    expect(text).toContain('referrerPhone');
    expect(text).toContain('12 Bramble Cottages'); // the fixture's refereeAddress
    expect(text).toContain('GU1 4AA'); // the fixture's refereePostcode
    expect(text).toContain('07700 900123'); // the fixture's refereePhone
    expect(text).toContain('Jane Fieldsworth'); // referrerName
    expect(text).toContain('01483 000111'); // referrerPhone

    // Absent on purpose.
    for (const shouldNotLeak of [
      '1949-08-04',
      'refereeDateOfBirth',
      'reasonId',
      '"reason"',
      world.reasonId,
      'answers',
      'Allergic to shellfish specifically',
      'reviewComment',
      'Confidential referral note',
      UNKNOWN_REFERRER.referrerEmail,
      'referrerEmail',
      UNKNOWN_REFERRER.referrerOrganisation,
      'referrerOrganisation',
      'lines',
      'stockItemId',
      'pickListId',
      'parcelId',
      'quantity',
      world.stockItems.Beans,
    ]) {
      expect(text).not.toContain(shouldNotLeak);
    }
  });
});
