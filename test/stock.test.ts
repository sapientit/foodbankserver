import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import {
  purchaseLines,
  purchases,
  STOCK_MOVEMENT_TYPES,
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
): Promise<string> {
  const response = await testApp.request('/api/v1/stock/items', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ name, shelfNumber }),
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

async function levels(testApp: TestApp, token: string) {
  const response = await testApp.request('/api/v1/stock/levels', { headers: authHeaders(token) });
  const body: { items: { id: string; name: string; quantityOnHand: number }[] } =
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

describe('the idempotency guards after the ledger rebuild', () => {
  it('keeps all three guards unique and partial', async () => {
    // 0011 rebuilt `stock_ledger` to narrow the movement-type CHECK, which
    // means every index on it was dropped and recreated by hand. Losing a
    // `WHERE` clause or a column here costs nothing at first and then quietly
    // stops stopping a double-tap, so the definitions are pinned rather than
    // trusted.
    const { results } = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'stock_ledger' AND sql IS NOT NULL
        ORDER BY name`,
    ).all<{ name: string; sql: string }>();
    const byName = new Map(results.map((row) => [row.name, row.sql.replace(/\s+/g, ' ')]));

    for (const [name, owner] of [
      ['idx_stock_ledger_parcel_movement', 'parcel_id'],
      ['idx_stock_ledger_purchase_movement', 'purchase_id'],
      ['idx_stock_ledger_stock_take_movement', 'stock_take_id'],
    ] as const) {
      const sql = byName.get(name);
      expect([name, sql]).toEqual([name, expect.stringContaining('CREATE UNIQUE INDEX')]);
      expect([name, sql]).toEqual([
        name,
        expect.stringContaining(`(\`${owner}\`,\`stock_item_id\`,\`movement_type\`)`),
      ]);
      expect([name, sql]).toEqual([
        name,
        expect.stringContaining(`WHERE "stock_ledger"."${owner}" IS NOT NULL`),
      ]);
    }
  });

  it('lets a hand correction repeat, because it owns none of the three keys', async () => {
    // The partial clauses are what keep the guards off every other movement.
    // Two identical corrections are a real thing a warehouse does twice.
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    for (let i = 0; i < 2; i++) {
      const response = await testApp.request('/api/v1/stock/adjustments', {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({
          stockItemId: sugar,
          quantityDelta: -1,
          movementType: 'wastage',
          reason: 'Split bag',
        }),
      });
      expect(response.status).toBe(204);
    }

    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(-2);
  });
});

describe('the ways stock moves', () => {
  it('accepts each of the six ways stock moves', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    for (const movementType of STOCK_MOVEMENT_TYPES) {
      const response = await testApp.request('/api/v1/stock/adjustments', {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({
          stockItemId: sugar,
          quantityDelta: 1,
          movementType,
          reason: `Recorded as ${movementType}`,
        }),
      });
      expect([movementType, response.status]).toEqual([movementType, 204]);
    }

    expect(STOCK_MOVEMENT_TYPES).toHaveLength(6);
    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(6);
  });

  it('refuses a movement type the charity no longer records', async () => {
    // Nine were guessed at; six were wanted. These three went in 0011, and the
    // request has to be turned away at the edge rather than by the CHECK.
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    for (const movementType of ['expiry', 'parcel_returned', 'stock_take_adjustment']) {
      const response = await testApp.request('/api/v1/stock/adjustments', {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({
          stockItemId: sugar,
          quantityDelta: -1,
          movementType,
          reason: 'Out of date',
        }),
      });
      expect([movementType, response.status]).toEqual([movementType, 400]);
    }

    expect(await db.select().from(stockLedger)).toHaveLength(0);
  });

  it('refuses a retired movement type at the database as well', async () => {
    // The CHECK constraint is the backstop: the Zod enum could be widened by
    // accident, but a retired value still cannot reach the ledger.
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');
    const now = new Date().toISOString();

    await expect(
      env.DB.prepare(
        `INSERT INTO stock_ledger
           (id, stock_item_id, quantity_delta, movement_type, occurred_at, created_at)
         VALUES (?, ?, ?, 'stock_take_adjustment', ?, ?)`,
      )
        .bind(crypto.randomUUID(), sugar, -1, now, now)
        .run(),
    ).rejects.toThrow();
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
      .where(eq(stockLedger.movementType, 'correction'));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.quantityDelta).toBe(-2);

    const byName = new Map((await levels(testApp, token)).map((i) => [i.name, i.quantityOnHand]));
    expect(byName.get('Sugar')).toBe(8);
    expect(byName.get('Beans')).toBe(20);
  });

  it('records the variance as a correction carrying the stock take it came from', async () => {
    // `stock_take_adjustment` is gone, so the variance is written as one of the
    // six. What still says where it came from is `stock_take_id` — see Q13,
    // which asks whether the charity wants the two kinds of correction told
    // apart at all.
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
      body: JSON.stringify({ counts: [{ stockItemId: sugar, countedQuantity: 8 }] }),
    });
    await testApp.request(`/api/v1/stock/takes/${takeId}/commit`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const [variance] = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.stockTakeId, takeId));

    expect(variance?.movementType).toBe('correction');
    expect(variance?.quantityDelta).toBe(-2);
    // And the level still derives from the sum, not from the count.
    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(8);
  });

  it('refuses a second ledger entry for the same stock take and item', async () => {
    // The stock take guard at the database level, independent of the service's
    // "already committed" check — the partial index has to survive the 0011
    // rebuild or a replayed commit doubles the variance.
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
      body: JSON.stringify({ counts: [{ stockItemId: sugar, countedQuantity: 5 }] }),
    });
    await testApp.request(`/api/v1/stock/takes/${takeId}/commit`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const now = new Date().toISOString();
    await expect(
      db.insert(stockLedger).values({
        id: crypto.randomUUID(),
        stockItemId: sugar,
        quantityDelta: 5,
        movementType: 'correction',
        parcelId: null,
        sessionId: null,
        purchaseId: null,
        stockTakeId: takeId,
        reason: 'Replayed commit',
        actorUserId: null,
        occurredAt: now,
        createdAt: now,
      }),
    ).rejects.toThrow();

    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(5);
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
  it('lets a team lead shop, count and correct stock', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

    const { lead, accessToken } = await teamLeadApp();

    const purchase = await lead.request('/api/v1/stock/purchases', {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({ lines: [{ stockItemId: sugar, quantity: 5 }] }),
    });
    expect(purchase.status).toBe(201);

    const opened = await lead.request('/api/v1/stock/takes', {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({ note: 'Saturday count' }),
    });
    expect(opened.status).toBe(201);
    const { id: takeId }: { id: string } = await opened.json();

    const counts = await lead.request(`/api/v1/stock/takes/${takeId}/counts`, {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({ counts: [{ stockItemId: sugar, countedQuantity: 4 }] }),
    });
    expect(counts.status).toBe(204);

    const committed = await lead.request(`/api/v1/stock/takes/${takeId}/commit`, {
      method: 'POST',
      headers: json(accessToken),
    });
    expect(committed.status).toBe(200);

    const adjustment = await lead.request('/api/v1/stock/adjustments', {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({
        stockItemId: sugar,
        quantityDelta: -1,
        movementType: 'wastage',
        reason: 'Split bag',
      }),
    });
    expect(adjustment.status).toBe(204);

    expect((await levels(testApp, token))[0]?.quantityOnHand).toBe(3);
  });

  it('refuses a team lead the stock item list itself', async () => {
    const { testApp, token } = await adminApp();
    const sugar = await createItem(testApp, token, 'Sugar', 'A1');

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
    await createItem(testApp, token, 'Sugar', 'A1');

    const duplicate = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ name: 'sugar', shelfNumber: 'B1' }),
    });

    expect(duplicate.status).toBe(409);
  });
});
