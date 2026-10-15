import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { voucherConfig } from '../src/db/schema/voucher-config.ts';
import { type ParcelGrid } from '../src/modules/rules/engine.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import { submitReferral } from './helpers/referral-fixtures.ts';
import {
  generatePickList,
  gridOf,
  saveGrid,
  setUpPickingWorld,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

/**
 * `GET /sessions/{sessionId}/model-summary` — the team leader's model summary.
 * `INITIAL_SPEC1.txt`, `#Model parcels and the household grid`.
 *
 * Same households, order and pick numbers as `referral-details`; the one
 * addition is the model parcel name the **current** grid gives each
 * household, read fresh on every request rather than snapshotted.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

let clientIpCounter = 0;
function nextClientIp(): string {
  clientIpCounter += 1;
  return `203.0.119.${String(clientIpCounter)}`;
}

interface ModelSummaryHouseholdBody {
  readonly pickNumber: number | null;
  readonly modelParcelName: string | null;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly adults: number;
  readonly children: number;
  readonly collectionMethod: string;
  readonly answers: Record<string, unknown>;
}

interface ModelSummaryResponseBody {
  readonly sessionId: string;
  readonly households: ModelSummaryHouseholdBody[];
}

interface PickListParcel {
  readonly id: string;
  readonly referralId: string;
  readonly pickNumber: number;
  readonly lines: { stockItemId: string; name: string; quantity: number }[];
}

async function pickingWorld(
  options: { capacity?: number; deliveryCapacity?: number } = {},
): Promise<{ testApp: TestApp; token: string; world: PickingWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const world = await setUpPickingWorld(testApp, accessToken, options);
  return { testApp, token: accessToken, world };
}

async function readModelSummary(
  testApp: TestApp,
  token: string,
  sessionId: string,
): Promise<{ status: number; body: Partial<ModelSummaryResponseBody>; text: string }> {
  const response = await testApp.request(`/api/v1/sessions/${sessionId}/model-summary`, {
    headers: authHeaders(token),
  });
  const text = await response.text();
  const body: Partial<ModelSummaryResponseBody> = text === '' ? {} : JSON.parse(text);
  return { status: response.status, body, text };
}

async function readSessionPickList(
  testApp: TestApp,
  token: string,
  sessionId: string,
): Promise<PickListParcel[]> {
  const response = await testApp.request(`/api/v1/sessions/${sessionId}/pick-list`, {
    headers: authHeaders(token),
  });
  const body: { parcels?: PickListParcel[] } = await response.json();
  return body.parcels ?? [];
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
  await db.delete(voucherConfig);
});

describe('GET /sessions/{sessionId}/model-summary — role access', () => {
  it('is open to an admin and a team lead, refused to a fuel administrator, and refused without a token', async () => {
    const { testApp, token, world } = await pickingWorld();
    await submitReferral(testApp, world, {}, { clientIp: nextClientIp() });

    const admin = await readModelSummary(testApp, token, world.sessionId);
    expect(admin.status).toBe(200);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: leadToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });
    const leadResult = await readModelSummary(lead, leadToken, world.sessionId);
    expect(leadResult.status).toBe(200);

    const fuel = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: fuelToken } = await devLogin(fuel, {
      email: 'fuel@foodbank.org',
      role: 'fuel_admin',
    });
    const fuelResult = await readModelSummary(fuel, fuelToken, world.sessionId);
    expect(fuelResult.status).toBe(403);

    const unauth = await testApp.request(`/api/v1/sessions/${world.sessionId}/model-summary`);
    expect(unauth.status).toBe(401);
  });
});

describe('unknown session', () => {
  it('reports a 404', async () => {
    const { testApp, token } = await pickingWorld();

    const result = await readModelSummary(testApp, token, crypto.randomUUID());
    expect(result.status).toBe(404);
  });
});

describe('who is included', () => {
  it('includes pending_review, active and reviewed referrals, and excludes cancelled and rejected ones', async () => {
    const { testApp, token, world } = await pickingWorld();

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
      { referrerEmail: 'someone@notonthelist.example', refereeSurname: 'Rejected' },
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

    const result = await readModelSummary(testApp, token, world.sessionId);
    expect(
      (result.body.households ?? []).map((household) => household.refereeSurname).sort(),
    ).toEqual(['Active', 'Reviewed'].sort());
    void active;
  });
});

describe('pickNumber', () => {
  it('is null before a pick list is generated, and the parcel pick number afterwards', async () => {
    const { testApp, token, world } = await pickingWorld();
    const { id } = await submitReferral(
      testApp,
      world,
      { refereeSurname: 'Ashworth' },
      { clientIp: nextClientIp() },
    );

    const before = await readModelSummary(testApp, token, world.sessionId);
    expect(before.body.households?.[0]?.pickNumber).toBeNull();

    await generatePickList(testApp, token, world.sessionId);
    const after = await readModelSummary(testApp, token, world.sessionId);

    const parcels = await readSessionPickList(testApp, token, world.sessionId);
    const expectedPickNumber = parcels.find((parcel) => parcel.referralId === id)?.pickNumber;
    expect(expectedPickNumber).toEqual(expect.any(Number));

    expect(after.body.households?.[0]?.pickNumber).toBe(expectedPickNumber);
  });
});

describe('modelParcelName', () => {
  it('reflects a grid edit on the next read, without rewriting the referral or an already-generated parcel', async () => {
    const { testApp, token, world } = await pickingWorld();
    // Household of 1: sum <= 2, so the fixture's grid resolves it to the
    // small "Single parcel".
    const { id } = await submitReferral(
      testApp,
      world,
      { refereeSurname: 'Ashworth', adults: 1, children: 0 },
      { clientIp: nextClientIp() },
    );
    await generatePickList(testApp, token, world.sessionId);

    const before = await readModelSummary(testApp, token, world.sessionId);
    expect(before.body.households?.[0]?.modelParcelName).toBe('Single parcel');

    const [referralBefore] = await db.select().from(referrals).where(eq(referrals.id, id));
    const linesBefore = (await readSessionPickList(testApp, token, world.sessionId)).find(
      (parcel) => parcel.referralId === id,
    )?.lines;
    expect(linesBefore).toBeDefined();

    // Edit the grid: the "1-0" cell now resolves to the large parcel.
    const editedGrid: ParcelGrid = { ...gridOf('Single parcel', 'Family parcel') };
    editedGrid['1-0'] = 'Family parcel';
    const saveResponse = await saveGrid(testApp, token, editedGrid);
    expect(saveResponse.status).toBe(200);

    const after = await readModelSummary(testApp, token, world.sessionId);
    expect(after.body.households?.[0]?.modelParcelName).toBe('Family parcel');

    // The referral's own stored counts are untouched by the grid edit.
    const [referralAfter] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(referralAfter?.adults).toBe(referralBefore?.adults);
    expect(referralAfter?.children).toBe(referralBefore?.children);

    // The parcel generated under the old grid keeps its original contents —
    // the grid edit affects future generation only, never a parcel that
    // already exists.
    const linesAfter = (await readSessionPickList(testApp, token, world.sessionId)).find(
      (parcel) => parcel.referralId === id,
    )?.lines;
    expect(linesAfter).toEqual(linesBefore);
  });

  it('is null when the current grid has no entry for a household size, and leaks no grid or model-parcel contents', async () => {
    const { testApp, token, world } = await pickingWorld();
    await submitReferral(
      testApp,
      world,
      { refereeSurname: 'Nocell', adults: 3, children: 3 },
      { clientIp: nextClientIp() },
    );

    // Remove the "3-3" cell from an otherwise-complete grid.
    const incompleteGrid: ParcelGrid = { ...gridOf('Single parcel', 'Family parcel') };
    delete incompleteGrid['3-3'];
    const saveResponse = await saveGrid(testApp, token, incompleteGrid);
    expect(saveResponse.status).toBe(200);

    const result = await readModelSummary(testApp, token, world.sessionId);
    expect(result.status).toBe(200);
    const household = result.body.households?.find(
      (h) => h.refereeSurname === 'Nocell' && h.adults === 3,
    );
    expect(household?.modelParcelName).toBeNull();

    // Nothing about the grid or the model parcels' contents leaks: no other
    // model parcel name, and no stock item identifiers or quantities.
    expect(result.text).not.toContain('Single parcel');
    expect(result.text).not.toContain('Family parcel');
    expect(result.text).not.toContain(world.stockItems.Beans);
    expect(result.text).not.toContain(world.stockItems.Pasta);
    expect(result.text).not.toContain(world.stockItems.Cereal);
    expect(result.text).not.toContain('quantity');
    expect(result.text).not.toContain('stockItemId');

    // And no field beyond the eight per household, plus the two top-level keys.
    const parsed = JSON.parse(result.text) as {
      sessionId: unknown;
      households: Record<string, unknown>[];
    };
    expect(Object.keys(parsed).sort()).toEqual(['households', 'sessionId']);
    const theHousehold = parsed.households.find((h) => h.refereeSurname === 'Nocell');
    expect(theHousehold).toBeDefined();
    expect(Object.keys(theHousehold ?? {}).sort()).toEqual(
      [
        'adults',
        'answers',
        'children',
        'collectionMethod',
        'modelParcelName',
        'pickNumber',
        'refereeFirstName',
        'refereeSurname',
      ].sort(),
    );
  });
});

describe('clamping', () => {
  it('resolves a household of 7 adults via the 5-adult grid cell, while reporting the true adults count', async () => {
    const { testApp, token, world } = await pickingWorld();
    await submitReferral(
      testApp,
      world,
      { refereeSurname: 'Bigfamily', adults: 7, children: 0 },
      { clientIp: nextClientIp() },
    );

    const result = await readModelSummary(testApp, token, world.sessionId);
    const household = result.body.households?.find((h) => h.refereeSurname === 'Bigfamily');

    // 5 (clamped) + 0 > 2, so the fixture's grid resolves it to the family
    // parcel — exactly as a genuine 5-adult household would.
    expect(household?.modelParcelName).toBe('Family parcel');
    expect(household?.adults).toBe(7);
    expect(household?.children).toBe(0);
  });
});

describe('collectionMethod and answers', () => {
  it("carries each household's collection method and its answers whole, unfiltered", async () => {
    const { testApp, token, world } = await pickingWorld();
    const answers = {
      'Household Components': { '0-2': { Female: 1 }, '18 to State Pension age': { Male: 1 } },
      'Other information': 'Ring the side door',
      Dietary: 'no pork',
    };
    await submitReferral(
      testApp,
      world,
      { refereeSurname: 'Collector', collectionMethod: 'referrer_collect', answers },
      { clientIp: nextClientIp() },
    );
    await submitReferral(
      testApp,
      world,
      { refereeSurname: 'Walkin', collectionMethod: 'collection' },
      { clientIp: nextClientIp() },
    );

    const result = await readModelSummary(testApp, token, world.sessionId);
    expect(result.status).toBe(200);
    const collector = result.body.households?.find((h) => h.refereeSurname === 'Collector');
    const walkin = result.body.households?.find((h) => h.refereeSurname === 'Walkin');

    expect(collector?.collectionMethod).toBe('referrer_collect');
    expect(collector?.answers).toEqual(answers);
    expect(walkin?.collectionMethod).toBe('collection');
  });
});
