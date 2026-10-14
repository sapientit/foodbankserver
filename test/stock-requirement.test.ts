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
import { stockItems, stockLedger, type StockItem } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import {
  stockRequirementLines,
  stockRequirementSummaryLines,
} from '../src/modules/pick-lists/stock-requirement.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  generatePickList,
  readPickList,
  reviewEveryParcel,
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

interface StockRequirementItem {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string | null;
  readonly shelfNumber: string;
  readonly isActive: boolean;
  readonly requiredQuantity: number;
  readonly earlierSessionsQuantity: number;
  readonly quantityOnHand: number;
  readonly shortfall: number;
}

async function stockRequirementResponse(
  testApp: TestApp,
  token: string,
  sessionId: string,
  order?: string,
): Promise<Response> {
  const query = order === undefined ? '' : `?order=${order}`;
  return testApp.request(`/api/v1/sessions/${sessionId}/stock-requirement${query}`, {
    headers: authHeaders(token),
  });
}

async function stockRequirement(
  testApp: TestApp,
  token: string,
  sessionId: string,
  order?: string,
): Promise<{ pickListId: string; items: StockRequirementItem[] }> {
  const response = await stockRequirementResponse(testApp, token, sessionId, order);
  expect(response.status).toBe(200);
  return response.json();
}

async function createItem(
  testApp: TestApp,
  token: string,
  name: string,
  shelfNumber: string,
  category = 'Tinned Goods',
): Promise<string> {
  const response = await testApp.request('/api/v1/stock/items', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ name, category, shelfNumber }),
  });
  expect(response.status).toBe(201);
  const { id }: { id: string } = await response.json();
  return id;
}

/**
 * A second session, on the same date as `setUpReferralWorld`'s own
 * (`2026-08-11`) unless told otherwise, so tests can build the back-to-back
 * pairs `INITIAL_SPEC1.txt` describes — "two sessions run back to back on the
 * same day". Capacity and duration are irrelevant to every test that uses
 * this, so they are fixed rather than threaded through as parameters.
 */
async function createSession(
  testApp: TestApp,
  token: string,
  overrides: { sessionDate?: string; startTime?: string } = {},
): Promise<string> {
  const response = await testApp.request('/api/v1/sessions', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      sessionDate: overrides.sessionDate ?? '2026-08-11',
      startTime: overrides.startTime ?? '13:00',
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

async function reviewParcel(testApp: TestApp, token: string, parcelId: string): Promise<void> {
  const response = await testApp.request(`/api/v1/parcels/${parcelId}/review`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
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

describe('the required quantity', () => {
  it('sums quantities for one item across every parcel on the list', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 }); // Single parcel: Beans 2
    const raised = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const { id } = await generatePickList(testApp, token, w.sessionId, [
      { referralId: raised.id, lines: [{ stockItemId: w.stockItems.Beans, quantity: 3 }] },
    ]);
    await reviewEveryParcel(testApp, token, id);

    const { items } = await stockRequirement(testApp, token, w.sessionId);

    expect(items).toEqual([expect.objectContaining({ name: 'Beans', requiredQuantity: 5 })]);
  });

  it('drops an item that exists and even has a ledger level, but that no parcel on the session asks for', async () => {
    const { testApp, token, world: w } = await world();
    const rice = await createItem(testApp, token, 'Rice', 'A5', 'Dried Goods');
    await testApp.request('/api/v1/stock/take', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ counts: [{ stockItemId: rice, countedQuantity: 20 }] }),
    });

    await submitReferral(testApp, w, { adults: 1, children: 0 }); // Single parcel: Beans only
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, id);

    const { items } = await stockRequirement(testApp, token, w.sessionId);

    expect(items.map((item) => item.name)).toEqual(['Beans']);
  });

  it('excludes a cancelled parcel from the total, and does not wait on it to be reviewed', async () => {
    const { testApp, token, world: w } = await world();
    const kept = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const drop = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const keptParcelId = rows.find((parcel) => parcel.referralId === kept.id)?.id ?? '';

    const cancelled = await testApp.request(`/api/v1/referrals/${drop.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(cancelled.status).toBe(200);

    // Only the surviving parcel is reviewed. The cancelled one is left
    // deliberately untouched — it must not hold up the answer, exactly as it
    // does not hold up printing.
    await reviewParcel(testApp, token, keptParcelId);

    const { items } = await stockRequirement(testApp, token, w.sessionId);
    const beans = items.find((item) => item.name === 'Beans');

    // Both households' model parcel gives 2 tins of Beans; only the one still
    // pending should be counted.
    expect(beans?.requiredQuantity).toBe(2);
  });

  it('still counts an attended parcel, even though its stock has already left quantityOnHand', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 }); // Single parcel: Beans 2
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const parcelId = rows[0]?.id ?? '';

    await reviewParcel(testApp, token, parcelId);

    const attended = await testApp.request(`/api/v1/parcels/${parcelId}/attendance`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ attendance: 'attended' }),
    });
    expect(attended.status).toBe(200);

    const { items } = await stockRequirement(testApp, token, w.sessionId);
    const beans = items.find((item) => item.name === 'Beans');

    // Deliberate: the household still counts towards what the session needed,
    // while the two tins it took have already come off the shelf and now show
    // up as a negative level. The list is still a draft throughout — recording
    // attendance and reading the requirement need no confirmation.
    expect(beans?.requiredQuantity).toBe(2);
    expect(beans?.quantityOnHand).toBe(-2);
    expect(beans?.shortfall).toBe(4);
  });
});

describe('earlier sessions the same day', () => {
  // `INITIAL_SPEC1.txt`, the paragraph beginning "Sometimes - over Christmas
  // especially": a later session's comparison also counts what an earlier
  // session the same day is still going to take off the shelf.

  it('adds a pending earlier parcel to earlierSessionsQuantity and raises the shortfall', async () => {
    const { testApp, token, world: w } = await world();
    const earlierSessionId = w.sessionId; // 10:00
    const laterSessionId = await createSession(testApp, token, { startTime: '13:00' });

    // Earlier session: one household, left pending and unreviewed — earlier
    // sessions carry no review gate.
    await submitReferral(testApp, w, { adults: 1, children: 0 }); // Beans x2
    await generatePickList(testApp, token, earlierSessionId);

    // Later session: the one we ask about, fully reviewed as its own gates require.
    const laterWorld = { ...w, sessionId: laterSessionId };
    await submitReferral(testApp, laterWorld, { adults: 1, children: 0 }); // Beans x2
    const { id: laterPickListId } = await generatePickList(testApp, token, laterSessionId);
    await reviewEveryParcel(testApp, token, laterPickListId);

    const { items } = await stockRequirement(testApp, token, laterSessionId);
    const beans = items.find((item) => item.name === 'Beans');

    // requiredQuantity 2 (this session) + earlierSessionsQuantity 2 (the
    // 10:00 session's still-pending household) against quantityOnHand 0.
    expect(beans).toMatchObject({
      requiredQuantity: 2,
      earlierSessionsQuantity: 2,
      quantityOnHand: 0,
      shortfall: 4,
    });
  });

  it('counts nothing for an earlier attended, no-show or cancelled parcel', async () => {
    const { testApp, token, world: w } = await world();
    const earlierSessionId = w.sessionId; // 10:00
    const laterSessionId = await createSession(testApp, token, { startTime: '13:00' });

    const attended = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const noShow = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const cancelled = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const { id: earlierPickListId } = await generatePickList(testApp, token, earlierSessionId);
    await reviewEveryParcel(testApp, token, earlierPickListId);
    const { parcels: earlierParcels } = await readPickList(testApp, token, earlierPickListId);
    const parcelFor = (referralId: string) =>
      earlierParcels.find((parcel) => parcel.referralId === referralId)?.id ?? '';

    await testApp.request(`/api/v1/parcels/${parcelFor(attended.id)}/attendance`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ attendance: 'attended' }),
    });
    await testApp.request(`/api/v1/parcels/${parcelFor(noShow.id)}/attendance`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ attendance: 'no_show' }),
    });
    const cancelledResponse = await testApp.request(`/api/v1/referrals/${cancelled.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(cancelledResponse.status).toBe(200);

    const laterWorld = { ...w, sessionId: laterSessionId };
    await submitReferral(testApp, laterWorld, { adults: 1, children: 0 }); // Beans x2
    const { id: laterPickListId } = await generatePickList(testApp, token, laterSessionId);
    await reviewEveryParcel(testApp, token, laterPickListId);

    const { items } = await stockRequirement(testApp, token, laterSessionId);
    const beans = items.find((item) => item.name === 'Beans');

    // None of the three contribute: attended has already left the shelf (hence
    // quantityOnHand -2, not counted again here), no-show took nothing, and
    // cancelled is not coming.
    expect(beans).toMatchObject({
      requiredQuantity: 2,
      earlierSessionsQuantity: 0,
      quantityOnHand: -2,
      shortfall: 4,
    });
  });

  it('excludes an earlier needs-attention line, and an unreviewed earlier parcel does not block the answer', async () => {
    const { testApp, token, world: w } = await world();
    const earlierSessionId = w.sessionId; // 10:00
    const laterSessionId = await createSession(testApp, token, { startTime: '13:00' });

    const earlierReferral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    await generatePickList(testApp, token, earlierSessionId, [
      {
        referralId: earlierReferral.id,
        lines: [{ stockItemId: w.stockItems.Beans, quantity: NEEDS_ATTENTION_QUANTITY }],
      },
    ]);
    // Left exactly as generation produced it: unreviewed, and still holding a
    // `-1` nobody has settled. Nothing about this session's own gates applies
    // to an *earlier* session, so neither should block the later one's answer.

    const laterWorld = { ...w, sessionId: laterSessionId };
    await submitReferral(testApp, laterWorld, { adults: 1, children: 0 }); // Beans x2
    const { id: laterPickListId } = await generatePickList(testApp, token, laterSessionId);
    await reviewEveryParcel(testApp, token, laterPickListId);

    const { items } = await stockRequirement(testApp, token, laterSessionId);
    const beans = items.find((item) => item.name === 'Beans');

    expect(beans).toMatchObject({ requiredQuantity: 2, earlierSessionsQuantity: 0 });
  });

  it('does not count a later session, a session at the same start time, or one on the day before', async () => {
    const { testApp, token, world: w } = await world();
    const tenOClock = w.sessionId;
    const thirteenHundred = await createSession(testApp, token, { startTime: '13:00' });
    const anotherTenOClock = await createSession(testApp, token, { startTime: '10:00' });
    const dayBefore = await createSession(testApp, token, {
      sessionDate: '2026-08-10',
      startTime: '09:00',
    });

    // A pending household needing Beans on each of the three sessions that
    // must not count towards the 10:00 session's comparison.
    for (const sessionId of [thirteenHundred, anotherTenOClock, dayBefore]) {
      const otherWorld = { ...w, sessionId };
      await submitReferral(testApp, otherWorld, { adults: 1, children: 0 });
      await generatePickList(testApp, token, sessionId);
    }

    // The 10:00 session itself needs Beans too, so there is a line to inspect.
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id: tenOClockPickListId } = await generatePickList(testApp, token, tenOClock);
    await reviewEveryParcel(testApp, token, tenOClockPickListId);

    const { items } = await stockRequirement(testApp, token, tenOClock);
    const beans = items.find((item) => item.name === 'Beans');

    expect(beans).toMatchObject({ requiredQuantity: 2, earlierSessionsQuantity: 0, shortfall: 2 });
  });

  it('does not count a session whose own status is cancelled, even with a parcel still pending', async () => {
    const { testApp, token, world: w } = await world();
    const earlierSessionId = w.sessionId; // 10:00
    const laterSessionId = await createSession(testApp, token, { startTime: '13:00' });

    await submitReferral(testApp, w, { adults: 1, children: 0 }); // Beans x2, left pending
    await generatePickList(testApp, token, earlierSessionId);

    // Cancelling the session through the API refuses while it still holds a
    // pending household, and cancelling that household would cancel the
    // parcel along with it — which this test must not do, since it is
    // specifically proving the session's own `status` is what is checked, not
    // the parcel's attendance (already covered above). So the status is
    // written directly, the same way the file already reaches a `-1` line
    // that generation alone can produce but the API cannot otherwise set.
    await db.update(sessions).set({ status: 'cancelled' }).where(eq(sessions.id, earlierSessionId));

    const laterWorld = { ...w, sessionId: laterSessionId };
    await submitReferral(testApp, laterWorld, { adults: 1, children: 0 }); // Beans x2
    const { id: laterPickListId } = await generatePickList(testApp, token, laterSessionId);
    await reviewEveryParcel(testApp, token, laterPickListId);

    const { items } = await stockRequirement(testApp, token, laterSessionId);
    const beans = items.find((item) => item.name === 'Beans');

    expect(beans).toMatchObject({ requiredQuantity: 2, earlierSessionsQuantity: 0, shortfall: 2 });
  });

  it('leaves off an item only the earlier session needs', async () => {
    const { testApp, token, world: w } = await world();
    const earlierSessionId = w.sessionId; // 10:00
    const laterSessionId = await createSession(testApp, token, { startTime: '13:00' });
    const rice = await createItem(testApp, token, 'Rice', 'A5', 'Dried Goods');

    const earlierReferral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    await generatePickList(testApp, token, earlierSessionId, [
      { referralId: earlierReferral.id, lines: [{ stockItemId: rice, quantity: 3 }] },
    ]);

    const laterWorld = { ...w, sessionId: laterSessionId };
    await submitReferral(testApp, laterWorld, { adults: 1, children: 0 }); // Beans x2 only
    const { id: laterPickListId } = await generatePickList(testApp, token, laterSessionId);
    await reviewEveryParcel(testApp, token, laterPickListId);

    const { items } = await stockRequirement(testApp, token, laterSessionId);

    // Rice is wholly the earlier session's business — it never appears here,
    // even though the earlier parcel calling for it is still pending.
    expect(items.map((item) => item.name)).toEqual(['Beans']);
  });
});

describe('the level and the shortfall', () => {
  it('covers a shortfall, an exact match, a surplus, and a negative level', async () => {
    const { testApp, token, world: w } = await world();
    const rice = await createItem(testApp, token, 'Rice', 'A5', 'Dried Goods');
    const referral = await submitReferral(testApp, w, { adults: 2, children: 3 }); // Family parcel

    const { id } = await generatePickList(testApp, token, w.sessionId, [
      {
        referralId: referral.id,
        lines: [
          { stockItemId: w.stockItems.Beans, quantity: 5 }, // shortfall case
          { stockItemId: w.stockItems.Pasta, quantity: 3 }, // exact case
          { stockItemId: w.stockItems.Cereal, quantity: 1 }, // surplus case (unraised model default)
          { stockItemId: rice, quantity: 2 }, // negative-level case
        ],
      },
    ]);
    await reviewEveryParcel(testApp, token, id);

    await testApp.request('/api/v1/stock/take', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        counts: [
          { stockItemId: w.stockItems.Beans, countedQuantity: 2 },
          { stockItemId: w.stockItems.Pasta, countedQuantity: 3 },
          { stockItemId: w.stockItems.Cereal, countedQuantity: 10 },
        ],
      }),
    });

    // A ledger row moving Rice into deficit without a stock take, to prove a
    // level really can go negative and is not clamped before the response.
    const now = new Date().toISOString();
    await db.insert(stockLedger).values({
      id: crypto.randomUUID(),
      stockItemId: rice,
      quantityDelta: -9,
      movementType: 'parcel_issued',
      parcelId: crypto.randomUUID(),
      sessionId: null,
      actorUserId: null,
      occurredAt: now,
      createdAt: now,
    });

    const { items } = await stockRequirement(testApp, token, w.sessionId);
    const byName = Object.fromEntries(items.map((item) => [item.name, item]));

    expect(byName.Beans).toMatchObject({ requiredQuantity: 5, quantityOnHand: 2, shortfall: 3 });
    expect(byName.Pasta).toMatchObject({ requiredQuantity: 3, quantityOnHand: 3, shortfall: 0 });
    expect(byName.Cereal).toMatchObject({ requiredQuantity: 1, quantityOnHand: 10, shortfall: 0 });
    expect(byName.Rice).toMatchObject({ requiredQuantity: 2, quantityOnHand: -9, shortfall: 11 });
    expect(byName.Rice?.shortfall).toBeGreaterThan(byName.Rice?.requiredQuantity ?? 0);
  });
});

describe('the review gate', () => {
  it('refuses while any parcel on the list is still unreviewed', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    await generatePickList(testApp, token, w.sessionId);

    // The list is a draft and nothing has been reviewed yet.
    const response = await stockRequirementResponse(testApp, token, w.sessionId);
    expect(response.status).toBe(409);
  });

  it('allows a draft list once every parcel has been reviewed', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, id);

    const response = await stockRequirementResponse(testApp, token, w.sessionId);
    expect(response.status).toBe(200);

    // The point Pete cares about: reviewing every parcel is enough on its own.
    const [row] = await db.select().from(pickLists).where(eq(pickLists.id, id));
    expect(row?.status).toBe('draft');
  });

  it('refuses a needs-attention line reached only by writing to parcel_lines directly', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const parcelId = rows[0]?.id ?? '';

    // Review through the API first — it refuses outright while a -1 line is
    // present, so this ordinary line has to be reviewed before one can exist.
    await reviewParcel(testApp, token, parcelId);

    // This state is unreachable through the API once a parcel is reviewed:
    // generation is the only place a -1 is written, and it is written onto a
    // parcel that is by definition new and unreviewed. The check stays as a
    // backstop anyway, because a -1 that reached the sum would not fail — it
    // would quietly take one off the figure the warehouse is told to expect,
    // and a silent under-count is worse than a refusal nobody can trigger
    // honestly.
    await db
      .update(parcelLines)
      .set({ quantity: NEEDS_ATTENTION_QUANTITY })
      .where(
        and(eq(parcelLines.parcelId, parcelId), eq(parcelLines.stockItemId, w.stockItems.Beans)),
      );

    const response = await stockRequirementResponse(testApp, token, w.sessionId);
    expect(response.status).toBe(409);
    const body: { error: { message: string } } = await response.json();
    expect(body.error.message).toBe(
      'Settle every item needing attention before comparing this pick list against stock',
    );
  });

  it('404s when the session has no pick list at all', async () => {
    const { testApp, token, world: w } = await world();

    const response = await stockRequirementResponse(testApp, token, w.sessionId);
    expect(response.status).toBe(404);
  });
});

describe('the confirmed-session gate', () => {
  it('refuses once the session itself is confirmed, even though every parcel is reviewed and nothing needs attention', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const parcelId = rows[0]?.id ?? '';

    await reviewParcel(testApp, token, parcelId);
    const attended = await testApp.request(`/api/v1/parcels/${parcelId}/attendance`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ attendance: 'attended' }),
    });
    expect(attended.status).toBe(200);

    // Every parcel has an outcome, so confirming succeeds.
    const confirmed = await testApp.request(`/api/v1/sessions/${w.sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(confirmed.status).toBe(200);

    const response = await stockRequirementResponse(testApp, token, w.sessionId);
    expect(response.status).toBe(409);
    const body: { error: { message: string } } = await response.json();
    expect(body.error.message).toBe(
      'This session has been confirmed, so it can no longer be compared against stock',
    );
  });
});

describe('ordering', () => {
  it('defaults to shelf order', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 2, children: 3 }); // Family: Beans, Pasta, Cereal
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, id);

    const { items } = await stockRequirement(testApp, token, w.sessionId);

    // Pasta A1, Cereal A2, Beans A3 — shelf order, not category or insertion.
    expect(items.map((item) => item.name)).toEqual(['Pasta', 'Cereal', 'Beans']);
  });

  it('sorts by category then normalised name when asked', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 2, children: 3 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, id);

    const { items } = await stockRequirement(testApp, token, w.sessionId, 'category');

    // Category order: Breakfast (Cereal), Dried Goods (Pasta), Tinned Goods (Beans).
    expect(items.map((item) => item.name)).toEqual(['Cereal', 'Pasta', 'Beans']);
  });

  it('refuses an unrecognised order value', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, id);

    const response = await stockRequirementResponse(testApp, token, w.sessionId, 'alphabetical');
    expect(response.status).toBe(400);
  });
});

describe('an inactive item still owed to a parcel', () => {
  it('is still returned, marked inactive rather than silently dropped', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 }); // Single parcel: Beans only
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const deactivated = await testApp.request(`/api/v1/stock/items/${w.stockItems.Beans}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ isActive: false }),
    });
    expect(deactivated.status).toBe(200);

    await reviewEveryParcel(testApp, token, id);

    const { items } = await stockRequirement(testApp, token, w.sessionId);

    expect(items).toEqual([
      expect.objectContaining({ name: 'Beans', isActive: false, requiredQuantity: 2 }),
    ]);
  });
});

describe('access', () => {
  it('lets a team lead read the requirement', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, id);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, { email: 'lead@foodbank.org', role: 'team_lead' });

    const response = await lead.request(`/api/v1/sessions/${w.sessionId}/stock-requirement`, {
      headers: authHeaders(accessToken),
    });
    expect(response.status).toBe(200);
  });

  it('refuses a fuel administrator', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, id);

    const { accessToken } = await devLogin(testApp, {
      email: 'fuel@foodbank.org',
      role: 'fuel_admin',
    });

    const response = await stockRequirementResponse(testApp, accessToken, w.sessionId);
    expect(response.status).toBe(403);
  });

  it('requires authentication', async () => {
    const { testApp, world: w } = await world();

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/stock-requirement`);
    expect(response.status).toBe(401);
  });
});

describe('stockRequirementLines (pure)', () => {
  function stockItem(overrides: Partial<StockItem> = {}): StockItem {
    return {
      id: 'item-1',
      name: 'Beans',
      nameNormalised: 'beans',
      description: null,
      category: 'Tinned Goods',
      shelfNumber: 'A1',
      lowStockThreshold: null,
      groupingId: null,
      unitsPerPack: null,
      packUnitLabel: null,
      isActive: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('returns nothing for an empty requirement map, whatever levels are on the shelf', () => {
    const beans = stockItem();

    const result = stockRequirementLines(
      [{ item: beans, quantityOnHand: 10 }],
      new Map(),
      new Map(),
    );

    expect(result).toEqual([]);
  });

  it('preserves the order the caller supplied levels in, rather than resorting', () => {
    const zebra = stockItem({ id: 'item-zebra', name: 'Zebra Feed' });
    const apple = stockItem({ id: 'item-apple', name: 'Apple Sauce' });
    const required = new Map([
      ['item-zebra', 3],
      ['item-apple', 5],
    ]);

    const result = stockRequirementLines(
      [
        { item: zebra, quantityOnHand: 1 },
        { item: apple, quantityOnHand: 1 },
      ],
      required,
      new Map(),
    );

    // Alphabetically 'Apple Sauce' precedes 'Zebra Feed'; the levels array
    // arrived Zebra-then-Apple, and the function must not have resorted it —
    // the caller's chosen order (shelf or category) is what it is trusted to
    // preserve.
    expect(result.map((line) => line.item.id)).toEqual(['item-zebra', 'item-apple']);
  });

  it('defaults earlierSessionsQuantity to 0 for an item with no earlier-session demand', () => {
    const beans = stockItem();

    const result = stockRequirementLines(
      [{ item: beans, quantityOnHand: 10 }],
      new Map([['item-1', 2]]),
      new Map(),
    );

    expect(result).toEqual([
      {
        item: beans,
        requiredQuantity: 2,
        earlierSessionsQuantity: 0,
        quantityOnHand: 10,
        shortfall: 0,
      },
    ]);
  });

  it('produces a shortfall from earlier-session demand alone, even though this session is fully met', () => {
    const beans = stockItem();

    // requiredQuantity and quantityOnHand are equal: with no earlier demand
    // this would be a shortfall of 0, the exact-match case the other describe
    // block above already covers.
    const result = stockRequirementLines(
      [{ item: beans, quantityOnHand: 1 }],
      new Map([['item-1', 1]]),
      new Map([['item-1', 3]]),
    );

    expect(result).toEqual([
      {
        item: beans,
        requiredQuantity: 1,
        earlierSessionsQuantity: 3,
        quantityOnHand: 1,
        shortfall: 3,
      },
    ]);
  });

  it('adds earlierSessionsQuantity only for an item this session also requires', () => {
    const beans = stockItem();

    // The map carries demand for an item ('item-other') that is not in
    // `levels` paired with a requirement at all — mirroring an item only an
    // earlier session calls for, which must never surface on this session's
    // comparison.
    const result = stockRequirementLines(
      [{ item: beans, quantityOnHand: 5 }],
      new Map([['item-1', 2]]),
      new Map([
        ['item-1', 1],
        ['item-other', 99],
      ]),
    );

    expect(result).toEqual([
      {
        item: beans,
        requiredQuantity: 2,
        earlierSessionsQuantity: 1,
        quantityOnHand: 5,
        shortfall: 0,
      },
    ]);
  });
});

describe('stockRequirementSummaryLines (pure)', () => {
  function stockItem(overrides: Partial<StockItem> = {}): StockItem {
    return {
      id: 'item-1',
      name: 'Beans',
      nameNormalised: 'beans',
      description: null,
      category: 'Tinned Goods',
      shelfNumber: 'A1',
      lowStockThreshold: null,
      groupingId: null,
      unitsPerPack: null,
      packUnitLabel: null,
      isActive: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('drops an item nothing requires, however high its stock level', () => {
    const beans = stockItem();

    const result = stockRequirementSummaryLines([{ item: beans, quantityOnHand: 999 }], new Map());

    expect(result).toEqual([]);
  });

  it('keeps an item with a requirement, carrying only the required quantity', () => {
    const beans = stockItem();

    const result = stockRequirementSummaryLines(
      [{ item: beans, quantityOnHand: 500 }],
      new Map([['item-1', 7]]),
    );

    expect(result).toEqual([{ item: beans, requiredQuantity: 7 }]);
    // Deliberately not a comparison report: no stock level travels with the
    // line, so there is nothing here for a `quantityOnHand` or a `shortfall`
    // to sit on, however large the level supplied.
    expect(result[0]).not.toHaveProperty('quantityOnHand');
    expect(result[0]).not.toHaveProperty('shortfall');
  });

  it('preserves the order the caller supplied levels in, rather than resorting', () => {
    const zebra = stockItem({ id: 'item-zebra', name: 'Zebra Feed' });
    const apple = stockItem({ id: 'item-apple', name: 'Apple Sauce' });
    const required = new Map([
      ['item-zebra', 3],
      ['item-apple', 5],
    ]);

    const result = stockRequirementSummaryLines(
      [
        { item: zebra, quantityOnHand: 1 },
        { item: apple, quantityOnHand: 1 },
      ],
      required,
    );

    expect(result.map((line) => line.item.id)).toEqual(['item-zebra', 'item-apple']);
  });
});
