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
import { stockRequirementLines } from '../src/modules/pick-lists/stock-requirement.ts';
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

async function confirmPickList(testApp: TestApp, token: string, pickListId: string): Promise<void> {
  const response = await testApp.request(`/api/v1/pick-lists/${pickListId}/confirm`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
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

  it('refuses an unreviewed parcel even once the list has been confirmed', async () => {
    // Proves confirmation is not a substitute for review under the new gate —
    // it used to be the whole gate, and the precondition changed under it.
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await confirmPickList(testApp, token, id);

    const response = await stockRequirementResponse(testApp, token, w.sessionId);
    expect(response.status).toBe(409);
  });

  it('allows a draft list once every parcel has been reviewed — confirmation is not required', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, id);

    const response = await stockRequirementResponse(testApp, token, w.sessionId);
    expect(response.status).toBe(200);

    // The point Pete cares about: the list genuinely never got confirmed.
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

describe('ordering', () => {
  it('defaults to shelf order', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 2, children: 3 }); // Family: Beans, Pasta, Cereal
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, id);

    const { items } = await stockRequirement(testApp, token, w.sessionId);

    // Cereal A1, Beans A2, Pasta A10 — shelf order, not category or insertion.
    expect(items.map((item) => item.name)).toEqual(['Cereal', 'Beans', 'Pasta']);
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
      shelfSortKey: 'A00000001',
      isActive: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('returns nothing for an empty requirement map, whatever levels are on the shelf', () => {
    const beans = stockItem();

    const result = stockRequirementLines([{ item: beans, quantityOnHand: 10 }], new Map());

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
    );

    // Alphabetically 'Apple Sauce' precedes 'Zebra Feed'; the levels array
    // arrived Zebra-then-Apple, and the function must not have resorted it —
    // the caller's chosen order (shelf or category) is what it is trusted to
    // preserve.
    expect(result.map((line) => line.item.id)).toEqual(['item-zebra', 'item-apple']);
  });
});
