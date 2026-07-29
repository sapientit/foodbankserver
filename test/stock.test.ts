import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import {
  purchaseLines,
  purchases,
  stockItems,
  stockLedger,
  stockTakeLines,
  stockTakes,
} from '../src/db/schema/stock.ts';
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
  lowStockThreshold: number | null = null,
): Promise<string> {
  const response = await testApp.request('/api/v1/stock/items', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ name, unit: 'tin', shelfNumber, lowStockThreshold }),
  });
  expect(response.status).toBe(201);
  const { id }: { id: string } = await response.json();
  return id;
}

async function levels(testApp: TestApp, token: string) {
  const response = await testApp.request('/api/v1/stock/levels', { headers: authHeaders(token) });
  const body: { items: { id: string; name: string; quantityOnHand: number; isLow: boolean }[] } =
    await response.json();
  return body.items;
}

beforeEach(async () => {
  await db.delete(stockLedger);
  await db.delete(purchaseLines);
  await db.delete(purchases);
  await db.delete(stockTakeLines);
  await db.delete(stockTakes);
  await db.delete(stockItems);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('stock levels', () => {
  it('derives the stock level as the sum of ledger entries', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    await testApp.request('/api/v1/stock/purchases', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ lines: [{ stockItemId: sugar, quantity: 10 }] }),
    });
    await testApp.request('/api/v1/stock/adjustments', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        stockItemId: sugar,
        quantityDelta: -3,
        movementType: 'wastage',
        reason: 'Water damage',
      }),
    });

    const [level] = await levels(testApp, token);
    expect(level?.quantityOnHand).toBe(7);

    // And it really is derived: no stored balance anywhere.
    const entries = await db.select().from(stockLedger).where(eq(stockLedger.stockItemId, sugar));
    expect(entries.map((e) => e.quantityDelta).sort((a, b) => a - b)).toEqual([-3, 10]);
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

  it('flags an item at or below its low-stock threshold', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1', 5);

    await testApp.request('/api/v1/stock/purchases', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ lines: [{ stockItemId: sugar, quantity: 5 }] }),
    });

    const [level] = await levels(testApp, token);
    expect(level?.isLow).toBe(true);
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

describe('recording a shop', () => {
  it('adds to existing stock rather than replacing it', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    for (const quantity of [10, 5]) {
      const response = await testApp.request('/api/v1/stock/purchases', {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ lines: [{ stockItemId: sugar, quantity }] }),
      });
      expect(response.status).toBe(201);
    }

    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(15);
  });

  it('writes one ledger entry per line, in a single purchase', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');
    const beans = await createItem(testApp, token, 'Beans', 'A2');

    await testApp.request('/api/v1/stock/purchases', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        note: 'Weekly shop',
        lines: [
          { stockItemId: sugar, quantity: 10 },
          { stockItemId: beans, quantity: 24 },
        ],
      }),
    });

    expect(await db.select().from(purchases)).toHaveLength(1);
    expect(await db.select().from(stockLedger)).toHaveLength(2);
    const byName = new Map((await levels(testApp, token)).map((i) => [i.name, i.quantityOnHand]));
    expect(byName.get('Sugar')).toBe(10);
    expect(byName.get('Beans')).toBe(24);
  });

  it('writes nothing at all when one line names an unknown item', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    const response = await testApp.request('/api/v1/stock/purchases', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        lines: [
          { stockItemId: sugar, quantity: 10 },
          { stockItemId: '00000000-0000-4000-8000-000000000000', quantity: 5 },
        ],
      }),
    });

    expect(response.status).toBe(404);
    expect(await db.select().from(purchases)).toHaveLength(0);
    expect(await db.select().from(stockLedger)).toHaveLength(0);
  });

  it('never updates a ledger row', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    await testApp.request('/api/v1/stock/purchases', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ lines: [{ stockItemId: sugar, quantity: 10 }] }),
    });
    const before = await db.select().from(stockLedger);

    await testApp.request('/api/v1/stock/adjustments', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        stockItemId: sugar,
        quantityDelta: -2,
        movementType: 'correction',
        reason: 'Miscount',
      }),
    });
    const after = await db.select().from(stockLedger);

    // The original entry is untouched; a compensating one was appended.
    expect(after).toHaveLength(2);
    expect(after.find((row) => row.id === before[0]?.id)).toEqual(before[0]);
  });
});

describe('the purchase idempotency guard', () => {
  it('refuses a second ledger entry for the same purchase and item', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    await testApp.request('/api/v1/stock/purchases', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ lines: [{ stockItemId: sugar, quantity: 10 }] }),
    });

    const [entry] = await db.select().from(stockLedger);
    const now = new Date().toISOString();

    // Simulate a retry that reuses the same purchase id — exactly what a
    // double-tapped save would do.
    await expect(
      db.insert(stockLedger).values({
        id: crypto.randomUUID(),
        stockItemId: sugar,
        quantityDelta: 10,
        movementType: 'purchase',
        parcelId: null,
        sessionId: null,
        purchaseId: entry?.purchaseId ?? null,
        stockTakeId: null,
        reason: null,
        actorUserId: null,
        occurredAt: now,
        createdAt: now,
      }),
    ).rejects.toThrow();

    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(10);
  });
});

describe('stock takes', () => {
  it('writes an adjustment only where the count differs', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');
    const beans = await createItem(testApp, token, 'Beans', 'A2');

    await testApp.request('/api/v1/stock/purchases', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        lines: [
          { stockItemId: sugar, quantity: 10 },
          { stockItemId: beans, quantity: 20 },
        ],
      }),
    });

    const opened = await testApp.request('/api/v1/stock/takes', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ note: 'Monthly count' }),
    });
    const { id: takeId }: { id: string } = await opened.json();

    await testApp.request(`/api/v1/stock/takes/${takeId}/counts`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        counts: [
          { stockItemId: sugar, countedQuantity: 8 }, // two missing
          { stockItemId: beans, countedQuantity: 20 }, // matches
        ],
      }),
    });

    const committed = await testApp.request(`/api/v1/stock/takes/${takeId}/commit`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    const result: {
      status: string;
      adjustments: { stockItemId: string; delta: number; expected: number; counted: number }[];
    } = await committed.json();

    expect(result.status).toBe('committed');
    expect(result.adjustments).toEqual([
      { stockItemId: sugar, expected: 10, counted: 8, delta: -2 },
    ]);

    // The variance is a ledger entry, not an overwritten level.
    const adjustments = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.movementType, 'stock_take_adjustment'));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.quantityDelta).toBe(-2);

    const byName = new Map((await levels(testApp, token)).map((i) => [i.name, i.quantityOnHand]));
    expect(byName.get('Sugar')).toBe(8);
    expect(byName.get('Beans')).toBe(20);
  });

  it('records what was expected, so the variance stays auditable', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    await testApp.request('/api/v1/stock/purchases', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ lines: [{ stockItemId: sugar, quantity: 10 }] }),
    });

    const opened = await testApp.request('/api/v1/stock/takes', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({}),
    });
    const { id: takeId }: { id: string } = await opened.json();

    await testApp.request(`/api/v1/stock/takes/${takeId}/counts`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ counts: [{ stockItemId: sugar, countedQuantity: 6 }] }),
    });
    await testApp.request(`/api/v1/stock/takes/${takeId}/commit`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const [line] = await db.select().from(stockTakeLines);
    expect(line?.expectedQuantity).toBe(10);
    expect(line?.countedQuantity).toBe(6);
  });

  it('refuses to commit twice', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    const opened = await testApp.request('/api/v1/stock/takes', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({}),
    });
    const { id: takeId }: { id: string } = await opened.json();
    await testApp.request(`/api/v1/stock/takes/${takeId}/counts`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ counts: [{ stockItemId: sugar, countedQuantity: 3 }] }),
    });

    const first = await testApp.request(`/api/v1/stock/takes/${takeId}/commit`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    const second = await testApp.request(`/api/v1/stock/takes/${takeId}/commit`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    // Critically, the adjustment was not applied twice.
    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(3);
  });

  it('lets a count be corrected before committing', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    const opened = await testApp.request('/api/v1/stock/takes', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({}),
    });
    const { id: takeId }: { id: string } = await opened.json();

    for (const countedQuantity of [3, 7]) {
      await testApp.request(`/api/v1/stock/takes/${takeId}/counts`, {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ counts: [{ stockItemId: sugar, countedQuantity }] }),
      });
    }

    expect(await db.select().from(stockTakeLines)).toHaveLength(1);
    await testApp.request(`/api/v1/stock/takes/${takeId}/commit`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(7);
  });
});

describe('autocomplete', () => {
  it('finds sugar from "sug"', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Sugar', 'A1');
    await createItem(testApp, token, 'Beans', 'A2');

    const response = await testApp.request('/api/v1/stock/search?q=sug', {
      headers: authHeaders(token),
    });
    const body: { items: { name: string }[] } = await response.json();

    expect(body.items.map((i) => i.name)).toEqual(['Sugar']);
  });

  it('falls back to an infix match when no prefix matches', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Caster Sugar', 'A1');

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
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');
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
  it('lets a team lead read levels but not change them', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    const lead = buildTestApp();
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    expect(
      (await lead.request('/api/v1/stock/levels', { headers: authHeaders(accessToken) })).status,
    ).toBe(200);

    const purchase = await lead.request('/api/v1/stock/purchases', {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({ lines: [{ stockItemId: sugar, quantity: 5 }] }),
    });
    expect(purchase.status).toBe(403);
  });

  it('refuses a duplicate item name', async () => {
    const { testApp, token } = await adminApp();
    await createItem(testApp, token, 'Sugar', 'A1');

    const duplicate = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ name: 'sugar', unit: 'bag', shelfNumber: 'B1' }),
    });

    expect(duplicate.status).toBe(409);
  });
});
