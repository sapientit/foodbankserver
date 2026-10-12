import { env } from 'cloudflare:workers';
import { eq, inArray, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { crateMembers, crates } from '../src/db/schema/crates.ts';
import { stockItems, stockLedger, type NewStockItem } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { NON_PERISHABLE_GROUPING_ID } from '../src/modules/stock/stock.service.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';

const db = createDatabase(env.DB);

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

async function adminApp(): Promise<{ testApp: TestApp; token: string }> {
  const testApp = buildTestApp();
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  return { testApp, token: accessToken };
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

async function teamLeadApp(): Promise<{ lead: TestApp; accessToken: string }> {
  const lead = buildTestApp();
  const { accessToken } = await devLogin(lead, {
    email: 'lead@foodbank.org',
    role: 'team_lead',
  });
  return { lead, accessToken };
}

async function takeCount(
  testApp: TestApp,
  token: string,
  counts: readonly { stockItemId: string; countedQuantity: number }[],
) {
  return testApp.request('/api/v1/stock/take', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ counts }),
  });
}

async function levels(testApp: TestApp, token: string, order?: string) {
  const query = order === undefined ? '' : `?order=${order}`;
  const response = await testApp.request(`/api/v1/stock/levels${query}`, {
    headers: authHeaders(token),
  });
  const body: { items: { id: string; name: string; quantityOnHand: number }[] } =
    await response.json();
  return body.items;
}

interface ItemFields {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string | null;
  readonly shelfNumber: string;
  readonly lowStockThreshold: number | null;
  readonly groupingId: string | null;
  readonly unitsPerPack: number | null;
  readonly packUnitLabel: string | null;
}

interface CrateMemberInput {
  readonly stockItemId: string;
  readonly stockCompositionPercent: number;
  readonly shoppingCompositionPercent: number;
}

async function createCrate(
  testApp: TestApp,
  token: string,
  body: {
    name: string;
    shelfKey: string;
    groupingId: string;
    sizePerCrate: number;
    members: CrateMemberInput[];
  },
): Promise<{ id: string }> {
  const response = await testApp.request('/api/v1/stock/crates', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function takeCrateCount(
  testApp: TestApp,
  token: string,
  crateCounts: readonly { crateId: string; enteredCount: number }[],
  counts: readonly { stockItemId: string; countedQuantity: number }[] = [],
) {
  return testApp.request('/api/v1/stock/take', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ counts, crateCounts }),
  });
}

async function itemsResponse(testApp: TestApp, token: string, order?: string): Promise<Response> {
  const query = order === undefined ? '' : `?order=${order}`;
  return testApp.request(`/api/v1/stock/items${query}`, { headers: authHeaders(token) });
}

async function items(testApp: TestApp, token: string, order?: string): Promise<ItemFields[]> {
  const response = await itemsResponse(testApp, token, order);
  const body: { items: ItemFields[] } = await response.json();
  return body.items;
}

beforeEach(async () => {
  // Children first: crate members reference both crates and stock items.
  await db.delete(crateMembers);
  await db.delete(crates);
  await db.delete(stockLedger);
  await db.delete(stockItems);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('stock levels', () => {
  it('does not expose a unit, and reports no threshold as null', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Beans', 'A2');

    const [level] = await levels(testApp, token);
    expect(level).toEqual(
      expect.objectContaining({
        name: 'Beans',
        shelfNumber: 'A2',
        quantityOnHand: 0,
        lowStockThreshold: null,
      }),
    );
    expect(level).not.toHaveProperty('unit');
    expect(level).not.toHaveProperty('isLow');
  });

  it('carries a set low stock threshold through /stock/levels, not just /stock/items', async () => {
    const { testApp, token } = await adminApp();
    await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Beans',
        category: 'Tinned Goods',
        shelfNumber: 'A2',
        lowStockThreshold: 5,
      }),
    });

    const [level] = await levels(testApp, token);
    expect(level).toEqual(expect.objectContaining({ name: 'Beans', lowStockThreshold: 5 }));
  });

  it('derives the stock level as the sum of ledger entries', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 10 }]);

    const [level] = await levels(testApp, token);
    expect(level?.quantityOnHand).toBe(10);

    // And it really is derived: no stored balance anywhere.
    const entries = await db.select().from(stockLedger).where(eq(stockLedger.stockItemId, sugar));
    expect(entries.map((entry) => entry.quantityDelta)).toEqual([10]);
    expect(entries[0]?.movementType).toBe('opening_balance');
  });

  it('reports zero for an item with no movements', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Beans', 'A2');

    const [level] = await levels(testApp, token);
    expect(level?.quantityOnHand).toBe(0);
  });

  it('orders the list by a plain sort of the shelf number as typed', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Tenth', 'A10');
    await createItem(testApp, token, 'Second', 'A2');
    await createItem(testApp, token, 'First', 'A1');

    // A plain string sort, no cleverness about the number: 'A10' sorts before
    // 'A2'. Numbering the shelves so the walk comes out right is a labelling
    // job — INITIAL_SPEC1.txt, "#Stock maintenance".
    expect((await levels(testApp, token)).map((item) => item.name)).toEqual([
      'First',
      'Tenth',
      'Second',
    ]);
    expect((await items(testApp, token, 'shelf')).map((item) => item.name)).toEqual([
      'First',
      'Tenth',
      'Second',
    ]);
  });

  it('re-sorts the list when a shelf number changes', async () => {
    const { testApp, token } = await adminApp();
    const a = await createItem(testApp, token, 'Alpha', 'B1');
    await createItem(testApp, token, 'Beta', 'A1');

    await testApp.request(`/api/v1/stock/items/${a}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ shelfNumber: 'A0' }),
    });

    expect((await levels(testApp, token)).map((item) => item.name)).toEqual(['Alpha', 'Beta']);
  });
});

describe('the stock take', () => {
  it('replaces what the system held rather than adjusting towards it', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 10 }]);
    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 4 }]);

    // One row, not a 10 and a -6. The count is the truth, not a correction
    // towards it.
    const entries = await db.select().from(stockLedger).where(eq(stockLedger.stockItemId, sugar));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.quantityDelta).toBe(4);
    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(4);
  });

  it('supersedes a parcel already issued against that item', async () => {
    // The whole point of the change: the count on the shelf wins over whatever
    // the system thought had happened to the item.
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    const now = new Date().toISOString();

    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 10 }]);
    await db.insert(stockLedger).values({
      id: crypto.randomUUID(),
      stockItemId: sugar,
      quantityDelta: -2,
      movementType: 'parcel_issued',
      parcelId: crypto.randomUUID(),
      sessionId: null,
      actorUserId: null,
      occurredAt: now,
      createdAt: now,
    });
    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(8);

    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 9 }]);

    const entries = await db.select().from(stockLedger).where(eq(stockLedger.stockItemId, sugar));
    expect(entries).toHaveLength(1);
    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(9);
  });

  it('leaves an item that was not sent completely alone', async () => {
    // An unchanged item is left out of the request. It must keep its history,
    // because "not sent" means either counted-and-correct or never counted.
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    const beans = await createItem(testApp, token, 'Beans', 'A2');

    await takeCount(testApp, token, [
      { stockItemId: sugar, countedQuantity: 10 },
      { stockItemId: beans, countedQuantity: 7 },
    ]);
    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 3 }]);

    const byName = Object.fromEntries(
      (await levels(testApp, token)).map((item) => [item.name, item.quantityOnHand]),
    );
    expect(byName).toEqual({ Sugar: 3, Beans: 7 });
  });

  it('records a count of zero by writing no row at all', async () => {
    // The ledger forbids a zero delta, and rightly. Deleting the history and
    // writing nothing leaves SUM() over no rows, which is zero.
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 10 }]);
    const response = await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 0 }]);

    expect(response.status).toBe(200);
    expect(await db.select().from(stockLedger).where(eq(stockLedger.stockItemId, sugar))).toEqual(
      [],
    );
    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(0);
  });

  it('leaves the same rows behind when the same page is saved twice', async () => {
    // A volunteer will double-tap save. There is no unique index here: the
    // delete removes what the previous save wrote, so repeating is idempotent
    // by construction.
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 6 }]);
    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 6 }]);

    const entries = await db.select().from(stockLedger).where(eq(stockLedger.stockItemId, sugar));
    expect(entries).toHaveLength(1);
    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(6);
  });

  it('reports the resulting level for each item in the page', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    const beans = await createItem(testApp, token, 'Beans', 'A2');

    const response = await takeCount(testApp, token, [
      { stockItemId: sugar, countedQuantity: 10 },
      { stockItemId: beans, countedQuantity: 0 },
    ]);

    expect(response.status).toBe(200);
    const body: { applied: number; levels: { stockItemId: string; quantityOnHand: number }[] } =
      await response.json();
    expect(body.applied).toBe(2);
    expect(body.levels).toEqual([
      { stockItemId: sugar, quantityOnHand: 10 },
      { stockItemId: beans, quantityOnHand: 0 },
    ]);
  });

  it('refuses the same item twice in one page', async () => {
    // Two counts for one item is ambiguous, and picking the later one would be
    // guessing at what is far more likely a client bug.
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const response = await takeCount(testApp, token, [
      { stockItemId: sugar, countedQuantity: 4 },
      { stockItemId: sugar, countedQuantity: 9 },
    ]);

    expect(response.status).toBe(400);
    expect(await db.select().from(stockLedger)).toEqual([]);
  });

  it('writes nothing at all when one item in the page is unknown', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 10 }]);

    const response = await takeCount(testApp, token, [
      { stockItemId: sugar, countedQuantity: 3 },
      { stockItemId: crypto.randomUUID(), countedQuantity: 5 },
    ]);

    expect(response.status).toBe(404);
    // Crucially the existing history survives: a bad id must not delete.
    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(10);
  });

  it('refuses a page larger than the request cap', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const response = await takeCount(
      testApp,
      token,
      Array.from({ length: 201 }, () => ({ stockItemId: sugar, countedQuantity: 1 })),
    );

    expect(response.status).toBe(400);
  });

  it('saves a full 120-item catalogue without hitting a bound-parameter limit', async () => {
    // 120 items is the real catalogue size, and `inArray` would bind one
    // parameter per id and fail. This is the test that proves `json_each`.
    const { testApp, token } = await adminApp();
    const ids: string[] = [];
    for (let index = 0; index < 120; index += 1) {
      ids.push(await createItem(testApp, token, `Item ${String(index)}`, `A${String(index)}`));
    }

    const response = await takeCount(
      testApp,
      token,
      ids.map((id, index) => ({ stockItemId: id, countedQuantity: index + 1 })),
    );

    expect(response.status).toBe(200);
    expect(await db.select().from(stockLedger)).toHaveLength(120);
  });
});

describe('the ways stock moves', () => {
  it('accepts the three ways stock moves', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    const now = new Date().toISOString();

    for (const movementType of ['opening_balance', 'parcel_issued', 'correction'] as const) {
      await db.insert(stockLedger).values({
        id: crypto.randomUUID(),
        stockItemId: sugar,
        quantityDelta: 1,
        movementType,
        parcelId: movementType === 'parcel_issued' ? crypto.randomUUID() : null,
        sessionId: null,
        actorUserId: null,
        occurredAt: now,
        createdAt: now,
      });
    }

    expect(await db.select().from(stockLedger)).toHaveLength(3);
  });

  it('refuses a movement type the charity no longer records', async () => {
    // Shopping, donations and wastage are gone. The CHECK constraint is what
    // stops one coming back through a stray insert. `correction` used to be
    // in this retired list too — it is a settled value again as of migration
    // `0035`, see `stock-correction.test.ts`.
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    const now = new Date().toISOString();

    for (const retired of ['purchase', 'donation', 'wastage']) {
      await expect(
        db.run(
          sql`INSERT INTO stock_ledger (id, stock_item_id, quantity_delta, movement_type, occurred_at, created_at)
              VALUES (${crypto.randomUUID()}, ${sugar}, 1, ${retired}, ${now}, ${now})`,
        ),
      ).rejects.toThrow();
    }
  });

  it('refuses a zero delta', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    const now = new Date().toISOString();

    await expect(
      db.insert(stockLedger).values({
        id: crypto.randomUUID(),
        stockItemId: sugar,
        quantityDelta: 0,
        movementType: 'opening_balance',
        parcelId: null,
        sessionId: null,
        actorUserId: null,
        occurredAt: now,
        createdAt: now,
      }),
    ).rejects.toThrow();
  });
});

describe('autocomplete', () => {
  it('finds sugar from "sug"', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    await createItem(testApp, token, 'Beans', 'A2');

    const response = await testApp.request('/api/v1/stock/search?q=sug', {
      headers: authHeaders(token),
    });
    const body: { items: { name: string }[] } = await response.json();

    expect(body.items.map((i) => i.name)).toEqual(['Sugar']);
  });

  it('falls back to an infix match when no prefix matches', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Caster Sugar', 'A1', 'Baking');

    const response = await testApp.request('/api/v1/stock/search?q=sugar', {
      headers: authHeaders(token),
    });
    const body: { items: { name: string }[] } = await response.json();

    expect(body.items.map((i) => i.name)).toEqual(['Caster Sugar']);
  });

  it('rejects an autocomplete term longer than forty characters', async () => {
    // D1 caps LIKE patterns at 50 bytes; exceeding it is a runtime SQL error,
    // so the term is bounded before it reaches the query.
    const { testApp, token } = await adminApp();

    const response = await testApp.request(`/api/v1/stock/search?q=${'a'.repeat(41)}`, {
      headers: authHeaders(token),
    });

    expect(response.status).toBe(400);
  });

  it('omits inactive items', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    await testApp.request(`/api/v1/stock/items/${sugar}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ isActive: false }),
    });

    const response = await testApp.request('/api/v1/stock/search?q=sug', {
      headers: authHeaders(token),
    });
    const body: { items: unknown[] } = await response.json();

    expect(body.items).toHaveLength(0);
  });
});

describe('stock authorisation', () => {
  it('lets a team lead count the stock', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const { lead, accessToken } = await teamLeadApp();

    const response = await takeCount(lead, accessToken, [
      { stockItemId: sugar, countedQuantity: 4 },
    ]);
    expect(response.status).toBe(200);

    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(4);
  });

  it('refuses a team lead the stock item list itself', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const { lead, accessToken } = await teamLeadApp();

    expect(
      (await lead.request('/api/v1/stock/levels', { headers: authHeaders(accessToken) })).status,
    ).toBe(200);

    const created = await lead.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({ name: 'Beans', shelfNumber: 'B2' }),
    });
    expect(created.status).toBe(403);

    const amended = await lead.request(`/api/v1/stock/items/${sugar}`, {
      method: 'PATCH',
      headers: json(accessToken),
      body: JSON.stringify({ shelfNumber: 'Z9' }),
    });
    expect(amended.status).toBe(403);
  });

  it('refuses a duplicate item name', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const duplicate = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ name: 'sugar', category: 'Baking', shelfNumber: 'B1' }),
    });

    expect(duplicate.status).toBe(409);
  });

  it('lets a team lead read /stock/items with the threshold field present, even though it cannot write it', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const { lead, accessToken } = await teamLeadApp();

    const response = await lead.request('/api/v1/stock/items', {
      headers: authHeaders(accessToken),
    });
    expect(response.status).toBe(200);
    const body: { items: ItemFields[] } = await response.json();
    expect(body.items[0]).toEqual(
      expect.objectContaining({ name: 'Sugar', lowStockThreshold: null }),
    );
  });

  it('refuses a team lead the low-stock summary, admin only unlike the rest of the stock routes', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const { lead, accessToken } = await teamLeadApp();

    const asLead = await lead.request('/api/v1/stock/items/low-stock-summary', {
      headers: authHeaders(accessToken),
    });
    expect(asLead.status).toBe(403);

    const asAdmin = await testApp.request('/api/v1/stock/items/low-stock-summary', {
      headers: authHeaders(token),
    });
    expect(asAdmin.status).toBe(200);
    expect(await asAdmin.json()).toEqual({ lowStockCount: 0 });
  });
});

describe('list ordering', () => {
  it('orders /stock/items by category then name by default, and /stock/levels by shelf', async () => {
    // A fixture where the two orders genuinely disagree: Zebra's category
    // sorts before Apple's, but Zebra's shelf sorts after Apple's. Passing
    // under both orderings by accident is impossible here.
    const { testApp, token } = await adminApp();
    const zebra = await createItem(testApp, token, 'Zebra', 'Z1', 'Apple');
    const apple = await createItem(testApp, token, 'Apple', 'A1', 'Zebra');

    // The maintenance screen: category order, Zebra's category (Apple) first.
    expect((await items(testApp, token)).map((i) => i.id)).toEqual([zebra, apple]);

    // The stock-take screen: shelf order, Apple's shelf (A1) first.
    expect((await levels(testApp, token)).map((i) => i.id)).toEqual([apple, zebra]);
  });

  it('lets /stock/items be asked for shelf order and /stock/levels for category order', async () => {
    const { testApp, token } = await adminApp();
    const zebra = await createItem(testApp, token, 'Zebra', 'Z1', 'Apple');
    const apple = await createItem(testApp, token, 'Apple', 'A1', 'Zebra');

    expect((await items(testApp, token, 'shelf')).map((i) => i.id)).toEqual([apple, zebra]);
    expect((await levels(testApp, token, 'category')).map((i) => i.id)).toEqual([zebra, apple]);
  });

  it('refuses an unrecognised order on either list', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    expect((await itemsResponse(testApp, token, 'alphabetical')).status).toBe(400);
    expect(
      (
        await testApp.request('/api/v1/stock/levels?order=alphabetical', {
          headers: authHeaders(token),
        })
      ).status,
    ).toBe(400);
  });

  it('breaks a category tie on the normalised name, not the raw one', async () => {
    // Case-sensitive comparison of the raw names would put 'Cherry' (capital
    // C) before 'banana', because uppercase sorts before lowercase in ASCII.
    // The normalised tiebreak puts them in the order a person reads them.
    const { testApp, token } = await adminApp();
    const cherry = await createItem(testApp, token, 'Cherry', 'A1', 'Fruit');
    const banana = await createItem(testApp, token, 'banana', 'A2', 'Fruit');

    expect((await items(testApp, token)).map((i) => i.id)).toEqual([banana, cherry]);
  });
});

describe('stock item fields', () => {
  it('round-trips a category and a description', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Long-Life Milk',
        category: 'dairy',
        description: 'UHT, 1 litre carton',
        shelfNumber: 'C1',
      }),
    });

    expect(response.status).toBe(201);
    const created: ItemFields = await response.json();
    expect(created.category).toBe('Dairy');
    expect(created.description).toBe('UHT, 1 litre carton');

    const [listed] = await items(testApp, token);
    expect(listed?.category).toBe('Dairy');
    expect(listed?.description).toBe('UHT, 1 litre carton');
  });

  it('gives null for a description that was never supplied', async () => {
    const { testApp, token } = await adminApp();
    const id = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const [listed] = await items(testApp, token);
    expect(listed?.id).toBe(id);
    expect(listed?.description).toBeNull();
  });

  it('clears a description to null on PATCH, whether sent as null or as an empty string', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Sugar',
        category: 'Baking',
        description: 'Caster, 1kg bag',
        shelfNumber: 'A1',
      }),
    });
    const { id }: { id: string } = await response.json();

    const clearedWithNull = await testApp.request(`/api/v1/stock/items/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ description: null }),
    });
    expect(clearedWithNull.status).toBe(200);
    const afterNull: ItemFields = await clearedWithNull.json();
    expect(afterNull.description).toBeNull();

    // Put a description back, then clear it again with an empty string.
    await testApp.request(`/api/v1/stock/items/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ description: 'Caster, 1kg bag' }),
    });
    const clearedWithEmpty = await testApp.request(`/api/v1/stock/items/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ description: '   ' }),
    });
    expect(clearedWithEmpty.status).toBe(200);
    const afterEmpty: ItemFields = await clearedWithEmpty.json();
    expect(afterEmpty.description).toBeNull();
  });

  it('settles the capitalisation of a category amended on PATCH', async () => {
    const { testApp, token } = await adminApp();
    const id = await createItem(testApp, token, 'Sugar', 'A1', 'baking');

    const patched = await testApp.request(`/api/v1/stock/items/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ category: 'BAKING SUPPLIES' }),
    });

    expect(patched.status).toBe(200);
    const body: ItemFields = await patched.json();
    expect(body.category).toBe('Baking Supplies');
  });

  it('refuses to create an item with no category', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ name: 'Sugar', shelfNumber: 'A1' }),
    });

    expect(response.status).toBe(400);
  });

  it('refuses a category over the forty-character limit', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ name: 'Sugar', category: 'a'.repeat(41), shelfNumber: 'A1' }),
    });

    expect(response.status).toBe(400);
  });

  it('refuses a description over the fifty-character limit', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Sugar',
        category: 'Baking',
        description: 'a'.repeat(51),
        shelfNumber: 'A1',
      }),
    });

    expect(response.status).toBe(400);
    expect(await db.select().from(stockItems)).toEqual([]);
  });

  it('allows a category and a description at exactly the limit', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Sugar',
        category: 'a'.repeat(40),
        description: 'b'.repeat(50),
        shelfNumber: 'A1',
      }),
    });

    expect(response.status).toBe(201);
  });

  // The name cap is the charity's own (INITIAL_SPEC1.txt, "#Stock
  // maintenance"): a name has to sit on one line of the picking sheet, the
  // same reasoning as the category and description caps above.
  it('refuses a name over the forty-character limit, and allows one at exactly the limit', async () => {
    const { testApp, token } = await adminApp();

    const tooLong = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ name: 'a'.repeat(41), category: 'Baking', shelfNumber: 'A1' }),
    });
    expect(tooLong.status).toBe(400);
    expect(await db.select().from(stockItems)).toEqual([]);

    const atLimit = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ name: 'a'.repeat(40), category: 'Baking', shelfNumber: 'A1' }),
    });
    expect(atLimit.status).toBe(201);
    const created: ItemFields = await atLimit.json();
    expect(created.name).toBe('a'.repeat(40));
  });

  it('accepts a name that is within the limit only once surrounding whitespace is trimmed', async () => {
    const { testApp, token } = await adminApp();

    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: `  ${'a'.repeat(40)}  `,
        category: 'Baking',
        shelfNumber: 'A1',
      }),
    });

    expect(response.status).toBe(201);
    const created: ItemFields = await response.json();
    expect(created.name).toBe('a'.repeat(40));
  });

  // The create and amend schemas are written separately, so the limits on one
  // are no evidence about the limits on the other. An amendment is the easier
  // of the two to let through by accident, and it reaches the same column.
  it('holds an amendment to the same limits as a creation', async () => {
    const { testApp, token } = await adminApp();
    const id = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    for (const body of [
      { name: 'a'.repeat(41) },
      { category: 'a'.repeat(41) },
      { description: 'b'.repeat(51) },
      // A category may be changed but not emptied: it is what the maintenance
      // and pick-list screens group by, so an item cannot be left without one.
      { category: '' },
      { category: '   ' },
    ]) {
      const response = await testApp.request(`/api/v1/stock/items/${id}`, {
        method: 'PATCH',
        headers: json(token),
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }

    // And the item is untouched by any of them.
    const [listed] = await items(testApp, token);
    expect(listed?.name).toBe('Sugar');
    expect(listed?.category).toBe('Baking');
  });

  it('allows a name and a description at exactly the limit on an amendment, independently of each other', async () => {
    const { testApp, token } = await adminApp();
    const id = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const renamed = await testApp.request(`/api/v1/stock/items/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ name: 'a'.repeat(40) }),
    });
    expect(renamed.status).toBe(200);
    const afterRename: ItemFields = await renamed.json();
    expect(afterRename.name).toBe('a'.repeat(40));

    const described = await testApp.request(`/api/v1/stock/items/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ description: 'b'.repeat(50) }),
    });
    expect(described.status).toBe(200);
    const afterDescription: ItemFields = await described.json();
    expect(afterDescription.description).toBe('b'.repeat(50));
  });
});

describe('low stock threshold', () => {
  it('round-trips a threshold through create and the item list, then clears it to null on patch', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Sugar',
        category: 'Baking',
        shelfNumber: 'A1',
        lowStockThreshold: 5,
      }),
    });
    expect(response.status).toBe(201);
    const created: ItemFields = await response.json();
    expect(created.lowStockThreshold).toBe(5);

    const [listed] = await items(testApp, token);
    expect(listed?.lowStockThreshold).toBe(5);

    const patchedToEight = await testApp.request(`/api/v1/stock/items/${created.id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ lowStockThreshold: 8 }),
    });
    expect(patchedToEight.status).toBe(200);
    const afterEight: ItemFields = await patchedToEight.json();
    expect(afterEight.lowStockThreshold).toBe(8);

    const patchedToNull = await testApp.request(`/api/v1/stock/items/${created.id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ lowStockThreshold: null }),
    });
    expect(patchedToNull.status).toBe(200);
    const afterNull: ItemFields = await patchedToNull.json();
    expect(afterNull.lowStockThreshold).toBeNull();

    // Cleared on the persisted row too, not just in the response just handed back.
    const [relisted] = await items(testApp, token);
    expect(relisted?.lowStockThreshold).toBeNull();
  });

  it('defaults an omitted threshold on create to null, not zero or an error', async () => {
    const { testApp, token } = await adminApp();
    const id = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const [listed] = await items(testApp, token);
    expect(listed?.id).toBe(id);
    expect(listed?.lowStockThreshold).toBeNull();
  });
});

describe('the low-stock summary', () => {
  async function lowStockCount(testApp: TestApp, token: string): Promise<number> {
    const response = await testApp.request('/api/v1/stock/items/low-stock-summary', {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);
    const body: { lowStockCount: number } = await response.json();
    return body.lowStockCount;
  }

  async function createItemWithThreshold(
    testApp: TestApp,
    token: string,
    name: string,
    shelfNumber: string,
    lowStockThreshold: number,
  ): Promise<string> {
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ name, category: 'Tinned Goods', shelfNumber, lowStockThreshold }),
    });
    expect(response.status).toBe(201);
    const { id }: { id: string } = await response.json();
    return id;
  }

  it('reports zero when nothing is below its threshold', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    expect(await lowStockCount(testApp, token)).toBe(0);
  });

  it('counts an item that has never been stock-taken as zero, not as excluded', async () => {
    const { testApp, token } = await adminApp();
    await createItemWithThreshold(testApp, token, 'Sugar', 'A1', 5);

    // No `POST /stock/take` at all: the ledger has no rows for this item, so
    // SUM(quantity_delta) is SQL NULL. `/stock/levels` coalesces that to a
    // quantityOnHand of 0, which is below the threshold of 5 and must count.
    expect(await lowStockCount(testApp, token)).toBe(1);
  });

  it('counts an item whose quantity on hand has fallen below its threshold', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItemWithThreshold(testApp, token, 'Sugar', 'A1', 5);
    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 3 }]);

    expect(await lowStockCount(testApp, token)).toBe(1);
  });

  it('does not count an item sitting exactly at its threshold, the strict less-than boundary', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItemWithThreshold(testApp, token, 'Sugar', 'A1', 5);
    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 5 }]);

    expect(await lowStockCount(testApp, token)).toBe(0);
  });

  it('counts an item one unit below its threshold, the other side of that boundary', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItemWithThreshold(testApp, token, 'Sugar', 'A1', 5);
    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 4 }]);

    expect(await lowStockCount(testApp, token)).toBe(1);
  });

  it('never counts an item with no threshold set, however low its quantity actually is', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 1 }]);

    expect(await lowStockCount(testApp, token)).toBe(0);
  });

  it('does not count an inactive item even though its quantity is below its threshold', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItemWithThreshold(testApp, token, 'Sugar', 'A1', 5);
    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 3 }]);

    const deactivated = await testApp.request(`/api/v1/stock/items/${sugar}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ isActive: false }),
    });
    expect(deactivated.status).toBe(200);

    expect(await lowStockCount(testApp, token)).toBe(0);
  });

  it('sums every low item, not just whether at least one exists', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItemWithThreshold(testApp, token, 'Sugar', 'A1', 5);
    const beans = await createItemWithThreshold(testApp, token, 'Beans', 'A2', 10);
    const flour = await createItemWithThreshold(testApp, token, 'Flour', 'A3', 3);
    // Not low: comfortably above its own threshold.
    const rice = await createItemWithThreshold(testApp, token, 'Rice', 'A4', 2);

    await takeCount(testApp, token, [
      { stockItemId: sugar, countedQuantity: 3 }, // below 5: low
      { stockItemId: beans, countedQuantity: 9 }, // below 10: low
      { stockItemId: flour, countedQuantity: 3 }, // at 3: not low
      { stockItemId: rice, countedQuantity: 20 }, // above 2: not low
    ]);

    expect(await lowStockCount(testApp, token)).toBe(2);
  });
});

describe('stock-take grouping backfill and defaulting', () => {
  it('defaults an omitted groupingId on create to the seeded Non-perishable grouping', async () => {
    const { testApp, token } = await adminApp();
    const id = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const [listed] = await items(testApp, token);
    expect(listed?.id).toBe(id);
    expect(listed?.groupingId).toBe(NON_PERISHABLE_GROUPING_ID);
  });

  it('stores an explicit null groupingId as null rather than defaulting it', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Crate Member',
        category: 'Tinned Goods',
        shelfNumber: 'A1',
        groupingId: null,
      }),
    });

    expect(response.status).toBe(201);
    const created: ItemFields = await response.json();
    expect(created.groupingId).toBeNull();

    const [listed] = await items(testApp, token);
    expect(listed?.groupingId).toBeNull();
  });
});

describe('groupingId, unitsPerPack and packUnitLabel', () => {
  it('round-trips groupingId, unitsPerPack and packUnitLabel through create and patch', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Tinned Tomatoes',
        category: 'Tinned Goods',
        shelfNumber: 'A3',
        groupingId: NON_PERISHABLE_GROUPING_ID,
        unitsPerPack: 12,
        packUnitLabel: 'box',
      }),
    });
    expect(response.status).toBe(201);
    const created: ItemFields = await response.json();
    expect(created.groupingId).toBe(NON_PERISHABLE_GROUPING_ID);
    expect(created.unitsPerPack).toBe(12);
    expect(created.packUnitLabel).toBe('box');

    const patched = await testApp.request(`/api/v1/stock/items/${created.id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ unitsPerPack: 6, packUnitLabel: 'sleeve' }),
    });
    expect(patched.status).toBe(200);
    const patchedBody: ItemFields = await patched.json();
    expect(patchedBody.unitsPerPack).toBe(6);
    expect(patchedBody.packUnitLabel).toBe('sleeve');
  });

  it('refuses an unknown groupingId on create with a clean 400, not a raw foreign-key error', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Tinned Tomatoes',
        category: 'Tinned Goods',
        shelfNumber: 'A3',
        groupingId: crypto.randomUUID(),
      }),
    });

    expect(response.status).toBe(400);
  });

  it('refuses an unknown groupingId on patch with a clean 400', async () => {
    const { testApp, token } = await adminApp();
    const id = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const response = await testApp.request(`/api/v1/stock/items/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ groupingId: crypto.randomUUID() }),
    });

    expect(response.status).toBe(400);
  });

  it('forces packUnitLabel to null when unitsPerPack is not supplied on create', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Sugar',
        category: 'Baking',
        shelfNumber: 'A1',
        packUnitLabel: 'box', // unitsPerPack omitted entirely
      }),
    });

    expect(response.status).toBe(201);
    const created: ItemFields = await response.json();
    expect(created.unitsPerPack).toBeNull();
    expect(created.packUnitLabel).toBeNull();
  });

  it('normalises a blank packUnitLabel alongside a real unitsPerPack to null on create', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Sugar',
        category: 'Baking',
        shelfNumber: 'A1',
        unitsPerPack: 4,
        packUnitLabel: '   ',
      }),
    });

    expect(response.status).toBe(201);
    const created: ItemFields = await response.json();
    expect(created.unitsPerPack).toBe(4);
    expect(created.packUnitLabel).toBeNull();
  });

  it('clears packUnitLabel to null when unitsPerPack is cleared on patch', async () => {
    const { testApp, token } = await adminApp();
    const createdResponse = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Sugar',
        category: 'Baking',
        shelfNumber: 'A1',
        unitsPerPack: 4,
        packUnitLabel: 'box',
      }),
    });
    const { id }: { id: string } = await createdResponse.json();

    const patched = await testApp.request(`/api/v1/stock/items/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ unitsPerPack: null }),
    });

    expect(patched.status).toBe(200);
    const body: ItemFields = await patched.json();
    expect(body.unitsPerPack).toBeNull();
    expect(body.packUnitLabel).toBeNull();
  });

  it('does not wipe an existing packUnitLabel when patching unitsPerPack alone', async () => {
    // Regression: sending { unitsPerPack: 6 } without resending packUnitLabel
    // must leave the stored label untouched.
    const { testApp, token } = await adminApp();
    const createdResponse = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Sugar',
        category: 'Baking',
        shelfNumber: 'A1',
        unitsPerPack: 4,
        packUnitLabel: 'box',
      }),
    });
    const { id }: { id: string } = await createdResponse.json();

    const patched = await testApp.request(`/api/v1/stock/items/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ unitsPerPack: 6 }),
    });

    expect(patched.status).toBe(200);
    const body: ItemFields = await patched.json();
    expect(body.unitsPerPack).toBe(6);
    expect(body.packUnitLabel).toBe('box');
  });
});

describe('crate counts on the stock take', () => {
  it('decomposes a crate count into member ledger deltas using stock composition percentages', async () => {
    const { testApp, token } = await adminApp();
    const item1 = await createItem(testApp, token, 'Crate Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Crate Item Two', 'C1');
    const crate = await createCrate(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 60, shoppingCompositionPercent: 60 },
        { stockItemId: item2, stockCompositionPercent: 40, shoppingCompositionPercent: 40 },
      ],
    });

    const response = await takeCrateCount(testApp, token, [{ crateId: crate.id, enteredCount: 2 }]);
    expect(response.status).toBe(200);
    const body: { applied: number; levels: { stockItemId: string; quantityOnHand: number }[] } =
      await response.json();
    expect(body.applied).toBe(1);
    const byId = Object.fromEntries(body.levels.map((l) => [l.stockItemId, l.quantityOnHand]));
    // enteredCount 2 * sizePerCrate 10 = 20 units; 60% -> 12, 40% -> 8.
    expect(byId).toEqual({ [item1]: 12, [item2]: 8 });

    const levelById = Object.fromEntries(
      (await levels(testApp, token)).map((item) => [item.id, item.quantityOnHand]),
    );
    expect(levelById[item1]).toBe(12);
    expect(levelById[item2]).toBe(8);
  });

  it('applies a crate count alongside an unrelated direct count in the same request', async () => {
    const { testApp, token } = await adminApp();
    const item1 = await createItem(testApp, token, 'Crate Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Crate Item Two', 'C1');
    const direct = await createItem(testApp, token, 'Direct Item', 'D1');
    const crate = await createCrate(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        { stockItemId: item2, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
      ],
    });

    const response = await takeCrateCount(
      testApp,
      token,
      [{ crateId: crate.id, enteredCount: 1 }],
      [{ stockItemId: direct, countedQuantity: 7 }],
    );
    expect(response.status).toBe(200);
    const body: { applied: number } = await response.json();
    expect(body.applied).toBe(2);

    const levelById = Object.fromEntries(
      (await levels(testApp, token)).map((item) => [item.id, item.quantityOnHand]),
    );
    expect(levelById[direct]).toBe(7);
    expect(levelById[item1]).toBe(5);
    expect(levelById[item2]).toBe(5);
  });

  it('refuses a stock item named by both a direct count and a crate count in the same page', async () => {
    const { testApp, token } = await adminApp();
    const item1 = await createItem(testApp, token, 'Crate Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Crate Item Two', 'C1');
    const crate = await createCrate(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        { stockItemId: item2, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
      ],
    });

    const response = await takeCrateCount(
      testApp,
      token,
      [{ crateId: crate.id, enteredCount: 1 }],
      [{ stockItemId: item1, countedQuantity: 3 }],
    );

    expect(response.status).toBe(400);
    expect(await db.select().from(stockLedger)).toEqual([]);
  });

  it('refuses two crates that share a member in the same page', async () => {
    const { testApp, token } = await adminApp();
    const shared = await createItem(testApp, token, 'Shared Item', 'C1');
    const extraA = await createItem(testApp, token, 'Crate A Extra', 'C1');
    const extraB = await createItem(testApp, token, 'Crate B Extra', 'C2');
    const crateA = await createCrate(testApp, token, {
      name: 'Crate A',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: shared, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        { stockItemId: extraA, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
      ],
    });
    const crateB = await createCrate(testApp, token, {
      name: 'Crate B',
      shelfKey: 'C2',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: shared, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        { stockItemId: extraB, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
      ],
    });

    const response = await takeCrateCount(testApp, token, [
      { crateId: crateA.id, enteredCount: 1 },
      { crateId: crateB.id, enteredCount: 1 },
    ]);

    expect(response.status).toBe(400);
    expect(await db.select().from(stockLedger)).toEqual([]);
  });

  it('accepts a crate count with one decimal place', async () => {
    const { testApp, token } = await adminApp();
    const item1 = await createItem(testApp, token, 'Crate Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Crate Item Two', 'C1');
    const crate = await createCrate(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 60, shoppingCompositionPercent: 60 },
        { stockItemId: item2, stockCompositionPercent: 40, shoppingCompositionPercent: 40 },
      ],
    });

    const response = await takeCrateCount(testApp, token, [
      { crateId: crate.id, enteredCount: 2.5 },
    ]);
    expect(response.status).toBe(200);

    const levelById = Object.fromEntries(
      (await levels(testApp, token)).map((item) => [item.id, item.quantityOnHand]),
    );
    // enteredCount 2.5 * sizePerCrate 10 = 25 units; 60% -> 15, 40% -> 10.
    expect(levelById[item1]).toBe(15);
    expect(levelById[item2]).toBe(10);
  });

  it('writes no ledger rows for any member when a crate count of zero is saved', async () => {
    const { testApp, token } = await adminApp();
    const item1 = await createItem(testApp, token, 'Crate Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Crate Item Two', 'C1');
    const crate = await createCrate(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 60, shoppingCompositionPercent: 60 },
        { stockItemId: item2, stockCompositionPercent: 40, shoppingCompositionPercent: 40 },
      ],
    });

    await takeCrateCount(testApp, token, [{ crateId: crate.id, enteredCount: 2 }]);
    const response = await takeCrateCount(testApp, token, [{ crateId: crate.id, enteredCount: 0 }]);
    expect(response.status).toBe(200);

    expect(
      await db
        .select()
        .from(stockLedger)
        .where(inArray(stockLedger.stockItemId, [item1, item2])),
    ).toEqual([]);
    const levelById = Object.fromEntries(
      (await levels(testApp, token)).map((item) => [item.id, item.quantityOnHand]),
    );
    expect(levelById[item1]).toBe(0);
    expect(levelById[item2]).toBe(0);
  });

  it('404s an unknown crateId and writes nothing at all', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    await takeCount(testApp, token, [{ stockItemId: sugar, countedQuantity: 10 }]);

    const response = await takeCrateCount(
      testApp,
      token,
      [{ crateId: crypto.randomUUID(), enteredCount: 1 }],
      [{ stockItemId: sugar, countedQuantity: 3 }],
    );

    expect(response.status).toBe(404);
    // The existing count survives: an unknown crate id must not write anything.
    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(10);
  });

  it('refuses a page where both counts and crateCounts are empty', async () => {
    const { testApp, token } = await adminApp();

    const response = await testApp.request('/api/v1/stock/take', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it('refuses a crate count that decomposes to a quantity larger than a direct count could ever be', async () => {
    // sizePerCrate and enteredCount are each individually within their own
    // schema limits, but their product is not bounded the way a direct
    // countedQuantity is — this pins the extra check that catches it.
    const { testApp, token } = await adminApp();
    const item1 = await createItem(testApp, token, 'Crate Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Crate Item Two', 'C1');
    const crate = await createCrate(testApp, token, {
      name: 'Huge Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 1000,
      members: [
        { stockItemId: item1, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        { stockItemId: item2, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
      ],
    });

    const response = await takeCrateCount(testApp, token, [
      { crateId: crate.id, enteredCount: 1000 },
    ]);

    expect(response.status).toBe(400);
    expect(await db.select().from(stockLedger)).toEqual([]);
  });
});

describe('GET /stock/validation', () => {
  it('is admin only', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    const { lead, accessToken } = await teamLeadApp();
    const asLead = await lead.request('/api/v1/stock/validation', {
      headers: authHeaders(accessToken),
    });
    expect(asLead.status).toBe(403);

    const asAdmin = await testApp.request('/api/v1/stock/validation', {
      headers: authHeaders(token),
    });
    expect(asAdmin.status).toBe(200);
  });

  it('flags a crate member whose stock item shelf no longer matches the crate shelf key', async () => {
    const { testApp, token } = await adminApp();
    const memberResponse = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Crate Member',
        category: 'Tinned Goods',
        shelfNumber: 'C1',
        groupingId: null,
      }),
    });
    const member: { id: string } = await memberResponse.json();
    const otherMemberResponse = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Other Member',
        category: 'Tinned Goods',
        shelfNumber: 'C1',
        groupingId: null,
      }),
    });
    const otherMember: { id: string } = await otherMemberResponse.json();

    const crate = await createCrate(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: member.id, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        {
          stockItemId: otherMember.id,
          stockCompositionPercent: 50,
          shoppingCompositionPercent: 50,
        },
      ],
    });

    // Drift: the shelf moves out from under the crate after the fact — the
    // crate write path never re-checks it.
    const moved = await testApp.request(`/api/v1/stock/items/${member.id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ shelfNumber: 'Z9' }),
    });
    expect(moved.status).toBe(200);

    const response = await testApp.request('/api/v1/stock/validation', {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);
    const body: {
      issues: { kind: string; stockItemId?: string; crateId?: string }[];
    } = await response.json();

    expect(body.issues).toContainEqual(
      expect.objectContaining({
        kind: 'crate_member_shelf_mismatch',
        crateId: crate.id,
        stockItemId: member.id,
      }),
    );
  });

  it('does not flag an active item and a retired item that share a shelf', async () => {
    const { testApp, token } = await adminApp();
    // Active "Flour" and its retired predecessor "Flour: SR" on one shelf.
    await createItem(testApp, token, 'Flour', 'S1', 'Baking');
    const retiredId = await createItem(testApp, token, 'Flour: SR', 'S1', 'Baking');

    const retire = await testApp.request(`/api/v1/stock/items/${retiredId}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ isActive: false }),
    });
    expect(retire.status).toBe(200);

    const response = await testApp.request('/api/v1/stock/validation', {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);
    const body: { issues: { kind: string; stockItemId?: string }[] } = await response.json();

    // No crate demanded for the shelf, and the retired item is not chased for
    // a missing count.
    expect(body.issues).toEqual([]);
  });
});

/**
 * Same reasoning as `isUniqueViolation` in `src/db/unique-violation.ts`: the
 * constraint name is not on the outer, Drizzle-wrapped error, and SQLite
 * reports it only in the `CHECK constraint failed: <name>` message further
 * down the `cause` chain.
 */
function violatesCheck(error: unknown, constraintName: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (
      current.message.includes('CHECK constraint failed') &&
      current.message.includes(constraintName)
    ) {
      return true;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

describe('the stock_items length CHECKs, at the database level', () => {
  // These bypass the route and `stock.schema.ts`'s Zod caps entirely — the
  // same reasoning as `seedStockItem` in `test/exports.test.ts` — to prove
  // the CHECKs added by migration `0043` hold on their own, not just because
  // the API happens to refuse the same input first.
  function rawItem(overrides: Partial<NewStockItem> = {}): NewStockItem {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      name: 'Control Item',
      nameNormalised: `control-item-${crypto.randomUUID()}`,
      shelfNumber: 'A1',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  async function insertRaw(overrides: Partial<NewStockItem>): Promise<unknown> {
    try {
      await db.insert(stockItems).values(rawItem(overrides));
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it('rejects a name of forty-one characters, with a boundary control insert that succeeds', async () => {
    const error = await insertRaw({
      name: 'a'.repeat(41),
      nameNormalised: `over-${crypto.randomUUID()}`,
    });

    expect(violatesCheck(error, 'stock_items_name_length')).toBe(true);

    // Control: the identically-shaped row one character shorter must
    // succeed, which is what rules out a mistake elsewhere in how this test
    // builds a row as the reason for the rejection above.
    await db
      .insert(stockItems)
      .values(rawItem({ name: 'a'.repeat(40), nameNormalised: `ok-${crypto.randomUUID()}` }));
    const rows = await db.select().from(stockItems);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('a'.repeat(40));
  });

  it('rejects a description of fifty-one characters, with a boundary control insert that succeeds', async () => {
    const error = await insertRaw({
      nameNormalised: `desc-over-${crypto.randomUUID()}`,
      description: 'b'.repeat(51),
    });

    expect(violatesCheck(error, 'stock_items_description_length')).toBe(true);

    await db
      .insert(stockItems)
      .values(
        rawItem({ nameNormalised: `desc-ok-${crypto.randomUUID()}`, description: 'b'.repeat(50) }),
      );
    const rows = await db.select().from(stockItems);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('b'.repeat(50));
  });

  it('accepts a NULL description by direct insert', async () => {
    await db
      .insert(stockItems)
      .values(rawItem({ nameNormalised: `desc-null-${crypto.randomUUID()}`, description: null }));

    const rows = await db.select().from(stockItems);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBeNull();
  });
});

describe('migration 0043 rebuild', () => {
  /**
   * `0043` only adds two `CHECK`s to `stock_items` — it adds no column and
   * drops none — so the table's pre- and post-migration column sets are
   * identical. `test/setup.ts` has already applied every migration,
   * including `0043`, before this test runs, so replaying the *entire*
   * migration a second time, against a table that already has the
   * post-`0043` shape plus rows seeded here, exercises exactly the same
   * CREATE/DROP/RENAME/INSERT/CREATE INDEX sequence over the same columns
   * that the real migration would run against a genuinely pre-`0043`
   * database. Reading the statements out of `env.TEST_MIGRATIONS` rather
   * than retyping them is the point, the same reasoning as the `0019` and
   * `0033` backfill tests: a test that restated the SQL would prove nothing
   * about what actually shipped.
   *
   * Unlike those two, there is no one-off `UPDATE` to isolate — the whole
   * statement list is the thing under test, and (unusually) safe to replay
   * in full: every `CREATE TABLE`/`CREATE INDEX` here targets a name the
   * first run's `DROP TABLE`/rename already cleared out of the way.
   */
  function rebuildStatements(): string[] {
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith('0043'));
    if (migration === undefined) {
      throw new Error('migration 0043 not found in TEST_MIGRATIONS — has it been renamed?');
    }
    return migration.queries;
  }

  /**
   * One `db.batch()`, not a loop of separate `.run()` calls: `PRAGMA
   * defer_foreign_keys=on` only defers a foreign-key check to the end of the
   * *transaction* it runs in, and `applyD1Migrations` itself runs every
   * migration's statements as one `db.batch()` for exactly this reason — a
   * loop of individually-committed statements would trip the check at the
   * `DROP TABLE`, before the re-`INSERT` ever runs.
   */
  async function runRebuild(): Promise<void> {
    await env.DB.batch(rebuildStatements().map((statement) => env.DB.prepare(statement)));
  }

  /**
   * The exact two `CONSTRAINT` clauses `0043` added to `__new_stock_items`,
   * read here so `withoutLengthChecks` can strip them back out — not
   * retyped, so a future edit to the migration that changes this text fails
   * loudly rather than leaving this test silently checking nothing.
   */
  const LENGTH_CHECK_CONSTRAINTS =
    ',\n\tCONSTRAINT "stock_items_name_length" CHECK(length("name") <= 40),\n\tCONSTRAINT "stock_items_description_length" CHECK("description" IS NULL OR length("description") <= 50)';

  /**
   * Turns `0043`'s own `CREATE TABLE __new_stock_items` statement back into
   * the shape it rebuilt *from*, by deleting exactly the `CONSTRAINT`
   * clauses the migration is documented to have added — nothing else in the
   * statement, or in the rest of the rebuild recipe, changes. That is what
   * makes `demoteStockItems()` below a genuine pre-`0043` table rather than
   * a hand-written stand-in for one.
   */
  function withoutLengthChecks(createTableStatement: string): string {
    if (!createTableStatement.includes(LENGTH_CHECK_CONSTRAINTS)) {
      throw new Error(
        "migration 0043's __new_stock_items CREATE TABLE text has changed — update this test's LENGTH_CHECK_CONSTRAINTS",
      );
    }
    return createTableStatement.replace(LENGTH_CHECK_CONSTRAINTS, '');
  }

  /**
   * Rebuilds `stock_items` into its genuine pre-`0043` shape — same columns,
   * same other constraints and indexes, missing only the two length
   * `CHECK`s — by replaying `0043`'s own recipe with that one statement
   * amended. This is the one legitimate way to get a CHECK that is already
   * live back out: the CHECK was added by a full table rebuild, so removing
   * it again means another one. Existing rows (and their foreign-key
   * children in other tables) carry forward unchanged, the same as a real
   * rebuild.
   */
  async function demoteStockItems(): Promise<void> {
    const statements = rebuildStatements().map((statement) =>
      statement.includes('CREATE TABLE `__new_stock_items`')
        ? withoutLengthChecks(statement)
        : statement,
    );
    await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
  }

  /** The names of any of the rebuild's scratch tables left behind. */
  async function leftoverScratchTables(): Promise<string[]> {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('__parked_stock_items', '__new_stock_items')`,
    ).all<{ name: string }>();
    return results.map((row) => row.name);
  }

  it('preserves an existing stock item and its stock_ledger foreign-key child across the rebuild', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    const now = new Date().toISOString();
    await db.insert(stockLedger).values({
      id: crypto.randomUUID(),
      stockItemId: sugar,
      quantityDelta: 10,
      movementType: 'opening_balance',
      parcelId: null,
      sessionId: null,
      actorUserId: null,
      occurredAt: now,
      createdAt: now,
    });

    await runRebuild();

    const [item] = await db.select().from(stockItems).where(eq(stockItems.id, sugar));
    expect(item?.name).toBe('Sugar');
    const entries = await db.select().from(stockLedger).where(eq(stockLedger.stockItemId, sugar));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.quantityDelta).toBe(10);
    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(10);
  });

  it('preserves a crate_members foreign-key child, with both of its composite key columns intact, across the rebuild', async () => {
    const { testApp, token } = await adminApp();
    const member = await createItem(testApp, token, 'Beans', 'B1', 'Tinned');
    const otherMember = await createItem(testApp, token, 'Peas', 'B1', 'Tinned');
    const crate = await createCrate(testApp, token, {
      name: 'Dry Goods Crate',
      shelfKey: 'B1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: member, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        {
          stockItemId: otherMember,
          stockCompositionPercent: 50,
          shoppingCompositionPercent: 50,
        },
      ],
    });

    await runRebuild();

    const members = await db.select().from(crateMembers).where(eq(crateMembers.crateId, crate.id));
    expect(members.map((row) => row.stockItemId).sort()).toEqual([member, otherMember].sort());
  });

  it('still has the length CHECKs after the rebuild', async () => {
    await runRebuild();

    let error: unknown;
    try {
      await db.insert(stockItems).values({
        id: crypto.randomUUID(),
        name: 'a'.repeat(41),
        nameNormalised: `post-rebuild-${crypto.randomUUID()}`,
        shelfNumber: 'A1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (caught) {
      error = caught;
    }

    expect(violatesCheck(error, 'stock_items_name_length')).toBe(true);
  });

  it('fails rather than truncates when a pre-existing row already holds a name over forty characters, leaving everything as it was', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    const now = new Date().toISOString();
    await db.insert(stockLedger).values({
      id: crypto.randomUUID(),
      stockItemId: sugar,
      quantityDelta: 10,
      movementType: 'opening_balance',
      parcelId: null,
      sessionId: null,
      actorUserId: null,
      occurredAt: now,
      createdAt: now,
    });

    // Put `stock_items` back into its genuine pre-`0043` shape — the CHECK
    // is live from `test/setup.ts` having already applied every migration,
    // so there is no other way to get a row past it that is sound.
    await demoteStockItems();

    // A row that could only have existed before `0043` ran: 44 characters,
    // bypassing the now-absent CHECK directly rather than through Zod.
    const overLongId = crypto.randomUUID();
    const overLongName = 'a'.repeat(44);
    await db.insert(stockItems).values({
      id: overLongId,
      name: overLongName,
      nameNormalised: overLongName,
      shelfNumber: 'Z1',
      createdAt: now,
      updatedAt: now,
    });

    let error: unknown;
    try {
      await runRebuild();
    } catch (caught) {
      error = caught;
    }
    expect(violatesCheck(error, 'stock_items_name_length')).toBe(true);

    // Nothing truncated, nothing lost, nothing left half-built: the batch
    // that failed is the one `runRebuild` sent, and D1 batches are
    // transactional (`.claude/rules/testing.md`), so the failed `INSERT`
    // rolls back the `DROP TABLE` and `RENAME` that preceded it in the same
    // batch along with it.
    const items = await db.select().from(stockItems);
    expect(items.map((item) => ({ id: item.id, name: item.name }))).toEqual(
      expect.arrayContaining([
        { id: sugar, name: 'Sugar' },
        { id: overLongId, name: overLongName },
      ]),
    );
    expect(items).toHaveLength(2);

    const entries = await db.select().from(stockLedger).where(eq(stockLedger.stockItemId, sugar));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.quantityDelta).toBe(10);

    expect(await leftoverScratchTables()).toEqual([]);
  });
});
