import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
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
  await db.delete(stockLedger);
  await db.delete(stockItems);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('stock levels', () => {
  it('does not expose units or low-stock warnings', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Beans', 'A2');

    const [level] = await levels(testApp, token);
    expect(level).toEqual(
      expect.objectContaining({ name: 'Beans', shelfNumber: 'A2', quantityOnHand: 0 }),
    );
    expect(level).not.toHaveProperty('unit');
    expect(level).not.toHaveProperty('lowStockThreshold');
    expect(level).not.toHaveProperty('isLow');
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

  it('orders the list by shelf so a picker walks the aisle once', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Tenth', 'A10');
    await createItem(testApp, token, 'Second', 'A2');
    await createItem(testApp, token, 'First', 'A1');

    expect((await levels(testApp, token)).map((item) => item.name)).toEqual([
      'First',
      'Second',
      'Tenth',
    ]);
  });

  it('keeps the shelf sort key in step when a shelf number changes', async () => {
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
  it('accepts the two ways stock moves', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    const now = new Date().toISOString();

    for (const movementType of ['opening_balance', 'parcel_issued'] as const) {
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

    expect(await db.select().from(stockLedger)).toHaveLength(2);
  });

  it('refuses a movement type the charity no longer records', async () => {
    // Shopping, donations, wastage and hand corrections are gone. The CHECK
    // constraint is what stops one coming back through a stray insert.
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');
    const now = new Date().toISOString();

    for (const retired of ['purchase', 'donation', 'wastage', 'correction']) {
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

  it('refuses a description over the two-hundred-character limit', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Sugar',
        category: 'Baking',
        description: 'a'.repeat(201),
        shelfNumber: 'A1',
      }),
    });

    expect(response.status).toBe(400);
  });

  it('allows a category and a description at exactly the limit', async () => {
    const { testApp, token } = await adminApp();
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Sugar',
        category: 'a'.repeat(40),
        description: 'b'.repeat(200),
        shelfNumber: 'A1',
      }),
    });

    expect(response.status).toBe(201);
  });

  // The create and amend schemas are written separately, so the limits on one
  // are no evidence about the limits on the other. An amendment is the easier
  // of the two to let through by accident, and it reaches the same column.
  it('holds an amendment to the same limits as a creation', async () => {
    const { testApp, token } = await adminApp();
    const id = await createItem(testApp, token, 'Sugar', 'A1', 'Baking');

    for (const body of [
      { category: 'a'.repeat(41) },
      { description: 'b'.repeat(201) },
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
    expect(listed?.category).toBe('Baking');
  });
});
