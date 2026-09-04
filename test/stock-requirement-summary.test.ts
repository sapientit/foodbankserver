import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import {
  NEEDS_ATTENTION_QUANTITY,
  parcelLines,
  parcels,
  pickLists,
} from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  generatePickList,
  readPickList,
  setUpPickingWorld,
  submitReferral,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

async function world(): Promise<{ testApp: TestApp; token: string; world: PickingWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const built = await setUpPickingWorld(testApp, accessToken);
  return { testApp, token: accessToken, world: built };
}

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

/** A second session, dated whatever a boundary or multi-session test needs. */
async function createSession(
  testApp: TestApp,
  token: string,
  sessionDate: string,
): Promise<string> {
  const response = await testApp.request('/api/v1/sessions', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      sessionDate,
      startTime: '10:00',
      durationMinutes: 120,
      location: 'Church Hall',
      capacity: 25,
      deliveryCapacity: 0,
    }),
  });
  expect(response.status).toBe(201);
  const { id }: { id: string } = await response.json();
  return id;
}

interface SummaryItem {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string | null;
  readonly shelfNumber: string;
  readonly isActive: boolean;
  readonly requiredQuantity: number;
}

async function summaryResponse(
  testApp: TestApp,
  token: string,
  upTo?: string,
  order?: string,
): Promise<Response> {
  const params = new URLSearchParams();
  if (upTo !== undefined) params.set('upTo', upTo);
  if (order !== undefined) params.set('order', order);
  const query = params.toString();
  return testApp.request(
    `/api/v1/pick-lists/stock-requirement-summary${query === '' ? '' : `?${query}`}`,
    { headers: authHeaders(token) },
  );
}

async function summary(
  testApp: TestApp,
  token: string,
  upTo: string,
  order?: string,
): Promise<{ items: SummaryItem[] }> {
  const response = await summaryResponse(testApp, token, upTo, order);
  expect(response.status).toBe(200);
  return response.json();
}

beforeEach(async () => {
  await db.delete(parcelLines);
  await db.delete(parcels);
  await db.delete(pickLists);
  await db.delete(modelParcels);
  await db.delete(parcelGrid);
  await db.delete(auditEvents);
  await db.delete(referrals);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(stockLedger);
  await db.delete(stockItems);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('the cut-off date', () => {
  it('includes a session dated exactly upTo and excludes one the day after', async () => {
    const { testApp, token, world: w } = await world();
    // w.sessionId is dated 2026-08-11 (setUpReferralWorld's fixture date).
    const laterSessionId = await createSession(testApp, token, '2026-08-12');

    await submitReferral(testApp, w, { adults: 1, children: 0 }); // Beans 2, on the boundary date
    await submitReferral(testApp, w, { adults: 1, children: 0 }); // Beans 2, same session
    await generatePickList(testApp, token, w.sessionId);

    await submitReferral(
      testApp,
      { ...w, sessionId: laterSessionId },
      { adults: 1, children: 0, refereeSurname: 'Laterday' },
    );
    await generatePickList(testApp, token, laterSessionId);

    const { items } = await summary(testApp, token, '2026-08-11');
    const beans = items.find((item) => item.name === 'Beans');

    // Two referrals landed on the boundary-date session (2 tins each); the
    // session dated the day after must not contribute its own 2 tins.
    expect(beans?.requiredQuantity).toBe(4);
  });

  it('excludes a session dated after upTo entirely when nothing on-or-before needs the item', async () => {
    const { testApp, token, world: w } = await world();
    const laterSessionId = await createSession(testApp, token, '2026-08-12');

    await submitReferral(testApp, { ...w, sessionId: laterSessionId }, { adults: 1, children: 0 });
    await generatePickList(testApp, token, laterSessionId);

    const { items } = await summary(testApp, token, '2026-08-11');

    expect(items.find((item) => item.name === 'Beans')).toBeUndefined();
  });
});

describe('the floor (start of the current week)', () => {
  // NOW is 2026-08-04T09:00Z, a Tuesday; the current week starts Monday 2026-08-03.
  //
  // Submitting a referral is refused once a session's date has passed the
  // public booking cutoff (`assertBookingCutoffNotPassed`), so a session dated
  // before the floor cannot be referred to under the standard `world()` clock
  // — by the time NOW is 2026-08-04, 2026-07-20 and 2026-08-03 are both
  // already in the past for that check. Each test here submits under a
  // second app instance whose clock is set safely earlier, sharing the same
  // underlying database, then reads the summary back through the normal
  // `world()` app so the floor is evaluated at the real NOW.
  async function submitUnderEarlierClock(
    w: PickingWorld,
    sessionDate: string,
    refereeSurname: string,
  ): Promise<void> {
    const earlyApp = buildTestApp({ clock: fixedClock('2026-07-01T09:00:00.000Z') });
    const { accessToken } = await devLogin(earlyApp, { email: 'admin@foodbank.org' });
    const sessionId = await createSession(earlyApp, accessToken, sessionDate);

    const referral = await submitReferral(
      earlyApp,
      { ...w, sessionId },
      { adults: 1, children: 0, refereeSurname },
    );
    // Guards against the setup itself silently failing (e.g. the booking
    // cutoff rejecting the date) and the test passing for the wrong reason.
    expect(referral.status).toBe(201);

    const generated = await generatePickList(earlyApp, accessToken, sessionId);
    expect(generated.parcelsCreated).toBeGreaterThanOrEqual(1);
  }

  it('excludes a session dated before the current week, unconfirmed and on or before upTo though it is', async () => {
    const { testApp, token, world: w } = await world();
    await submitUnderEarlierClock(w, '2026-07-20', 'Longago');

    const { items } = await summary(testApp, token, '2099-01-01');

    expect(items.find((item) => item.name === 'Beans')).toBeUndefined();
  });

  it('includes a session dated exactly on the first day of the current week', async () => {
    const { testApp, token, world: w } = await world();
    await submitUnderEarlierClock(w, '2026-08-03', 'Mondayhouse');

    const { items } = await summary(testApp, token, '2099-01-01');
    const beans = items.find((item) => item.name === 'Beans');

    expect(beans?.requiredQuantity).toBe(2);
  });
});

describe('the confirmed-session exclusion', () => {
  it('excludes a session once it is confirmed, even though its date is on or before upTo', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const parcelId = rows[0]?.id ?? '';

    await testApp.request(`/api/v1/parcels/${parcelId}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    const attended = await testApp.request(`/api/v1/parcels/${parcelId}/attendance`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ attendance: 'attended' }),
    });
    expect(attended.status).toBe(200);

    const confirmed = await testApp.request(`/api/v1/sessions/${w.sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(confirmed.status).toBe(200);

    const { items } = await summary(testApp, token, '2026-08-11');

    expect(items.find((item) => item.name === 'Beans')).toBeUndefined();
  });
});

describe('a -1 needs-attention line', () => {
  it('is skipped from the sum rather than refused, while the parcel other lines still count', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 2, children: 3 }); // Family parcel
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const parcelId = rows.find((parcel) => parcel.referralId === referral.id)?.id ?? '';

    // Written directly: a -1 can only ever be produced by generation's own
    // rules, and this pins the sum's behaviour against the sentinel value
    // without needing that machinery.
    await db
      .update(parcelLines)
      .set({ quantity: NEEDS_ATTENTION_QUANTITY })
      .where(
        and(eq(parcelLines.parcelId, parcelId), eq(parcelLines.stockItemId, w.stockItems.Beans)),
      );

    // No review happens at all — proving this endpoint does not error on a -1
    // the way the per-session `stockRequirement` does.
    const { items } = await summary(testApp, token, '2026-08-11');
    const byName = Object.fromEntries(items.map((item) => [item.name, item]));

    expect(byName.Beans).toBeUndefined();
    expect(byName.Pasta?.requiredQuantity).toBe(2);
    expect(byName.Cereal?.requiredQuantity).toBe(1);
  });
});

describe('a cancelled parcel', () => {
  it('is excluded from the sum, leaving the surviving parcel counted', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 }); // kept
    const dropped = await submitReferral(testApp, w, { adults: 1, children: 0 });
    await generatePickList(testApp, token, w.sessionId);

    const cancelled = await testApp.request(`/api/v1/referrals/${dropped.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(cancelled.status).toBe(200);

    const { items } = await summary(testApp, token, '2026-08-11');
    const beans = items.find((item) => item.name === 'Beans');

    // Only the surviving referral's single parcel (2 tins) should count; the
    // cancelled one must not add its 2 as well.
    expect(beans?.requiredQuantity).toBe(2);
  });
});

describe('the review gate', () => {
  it('counts an unreviewed parcel, unlike the per-session stock-requirement report', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    await generatePickList(testApp, token, w.sessionId);

    // Deliberately no review at all before reading the summary.
    const { items } = await summary(testApp, token, '2026-08-11');
    const beans = items.find((item) => item.name === 'Beans');

    expect(beans?.requiredQuantity).toBe(2);
  });
});

describe('summing across sessions', () => {
  it('adds the requirement from more than one session into a single total', async () => {
    const { testApp, token, world: w } = await world();
    const secondSessionId = await createSession(testApp, token, '2026-08-12');

    await submitReferral(testApp, w, { adults: 1, children: 0 }); // Beans 2, session one
    await generatePickList(testApp, token, w.sessionId);

    await submitReferral(
      testApp,
      { ...w, sessionId: secondSessionId },
      { adults: 1, children: 0, refereeSurname: 'Secondhouse' },
    ); // Beans 2, session two
    await generatePickList(testApp, token, secondSessionId);

    const { items } = await summary(testApp, token, '2026-08-12');
    const beans = items.find((item) => item.name === 'Beans');

    expect(beans?.requiredQuantity).toBe(4);
  });
});

describe('the response shape', () => {
  it('carries only a required quantity, never a stock level or a shortfall, and drops items nobody needs', async () => {
    const { testApp, token, world: w } = await world();
    // Rice exists and has a stock level, but no parcel on any session asks for it.
    const rice = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ name: 'Rice', category: 'Dried Goods', shelfNumber: 'A5' }),
    });
    const { id: riceId }: { id: string } = await rice.json();
    await testApp.request('/api/v1/stock/take', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ counts: [{ stockItemId: riceId, countedQuantity: 20 }] }),
    });

    await submitReferral(testApp, w, { adults: 1, children: 0 }); // Beans only
    await generatePickList(testApp, token, w.sessionId);

    const { items } = await summary(testApp, token, '2026-08-11');

    expect(items.map((item) => item.name)).toEqual(['Beans']);
    const beans = items.find((item) => item.name === 'Beans');
    expect(beans).not.toHaveProperty('quantityOnHand');
    expect(beans).not.toHaveProperty('shortfall');
    expect(Object.keys(beans ?? {}).sort()).toEqual(
      [
        'category',
        'description',
        'id',
        'isActive',
        'name',
        'requiredQuantity',
        'shelfNumber',
      ].sort(),
    );
  });
});

describe('ordering', () => {
  it('sorts by category then normalised name when asked', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 2, children: 3 }); // Family: Beans, Pasta, Cereal
    await generatePickList(testApp, token, w.sessionId);

    const { items } = await summary(testApp, token, '2026-08-11', 'category');

    // Category order: Breakfast (Cereal), Dried Goods (Pasta), Tinned Goods (Beans).
    expect(items.map((item) => item.name)).toEqual(['Cereal', 'Pasta', 'Beans']);
  });
});

describe('access', () => {
  it('lets an admin read the summary', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    await generatePickList(testApp, token, w.sessionId);

    const response = await summaryResponse(testApp, token, '2026-08-11');
    expect(response.status).toBe(200);
  });

  it('refuses a team lead — admin only, unlike the rest of the pick-list routes', async () => {
    const { testApp } = await world();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await summaryResponse(testApp, accessToken, '2026-08-11');
    expect(response.status).toBe(403);
  });

  it('requires authentication', async () => {
    const { testApp } = await world();

    const response = await testApp.request(
      '/api/v1/pick-lists/stock-requirement-summary?upTo=2026-08-11',
    );
    expect(response.status).toBe(401);
  });
});

describe('validation', () => {
  it('400s when upTo is missing', async () => {
    const { testApp, token } = await world();

    const response = await summaryResponse(testApp, token);
    expect(response.status).toBe(400);
  });

  it('400s when upTo is not a real calendar date', async () => {
    const { testApp, token } = await world();

    const response = await summaryResponse(testApp, token, '2026-02-30');
    expect(response.status).toBe(400);
  });

  it('400s when upTo is not shaped like a date at all', async () => {
    const { testApp, token } = await world();

    const response = await summaryResponse(testApp, token, 'not-a-date');
    expect(response.status).toBe(400);
  });
});
