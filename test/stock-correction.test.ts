import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';

const db = createDatabase(env.DB);

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

async function loginAs(role: 'admin' | 'team_lead'): Promise<{ testApp: TestApp; token: string }> {
  const testApp = buildTestApp();
  const { accessToken } = await devLogin(testApp, { email: `${role}@foodbank.org`, role });
  return { testApp, token: accessToken };
}

async function createItem(testApp: TestApp, token: string, name: string): Promise<string> {
  const response = await testApp.request('/api/v1/stock/items', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ name, category: 'Tinned Goods', shelfNumber: 'A1' }),
  });
  expect(response.status).toBe(201);
  const { id }: { id: string } = await response.json();
  return id;
}

async function correct(
  testApp: TestApp,
  token: string,
  stockItemId: string,
  quantityDelta: number,
): Promise<Response> {
  return testApp.request(`/api/v1/stock/items/${stockItemId}/corrections`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ quantityDelta }),
  });
}

async function takeCount(
  testApp: TestApp,
  token: string,
  stockItemId: string,
  countedQuantity: number,
): Promise<Response> {
  return testApp.request('/api/v1/stock/take', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ counts: [{ stockItemId, countedQuantity }] }),
  });
}

beforeEach(async () => {
  await db.delete(stockLedger);
  await db.delete(stockItems);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('stock corrections', () => {
  it('lets a team lead apply a positive correction', async () => {
    const { testApp: admin, token: adminToken } = await loginAs('admin');
    const sugar = await createItem(admin, adminToken, 'Sugar');

    const { testApp: lead, token: leadToken } = await loginAs('team_lead');
    const response = await correct(lead, leadToken, sugar, 5);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ quantityOnHand: 5 });
  });

  it('stamps no actor on the ledger row, per the settled decision that nothing is kept about who made a correction', async () => {
    const { testApp: admin, token: adminToken } = await loginAs('admin');
    const sugar = await createItem(admin, adminToken, 'Sugar');

    const { testApp: lead, token: leadToken } = await loginAs('team_lead');
    expect((await correct(lead, leadToken, sugar, 5)).status).toBe(200);

    const [entry] = await db.select().from(stockLedger).where(eq(stockLedger.stockItemId, sugar));
    expect(entry?.actorUserId).toBeNull();
  });

  it('lets a team lead apply a negative correction', async () => {
    const { testApp: admin, token: adminToken } = await loginAs('admin');
    const sugar = await createItem(admin, adminToken, 'Sugar');

    const { testApp: lead, token: leadToken } = await loginAs('team_lead');
    expect((await takeCount(lead, leadToken, sugar, 10)).status).toBe(200);

    const response = await correct(lead, leadToken, sugar, -3);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ quantityOnHand: 7 });
  });

  it('combines with existing opening_balance and parcel_issued rows rather than replacing them', async () => {
    const { testApp: admin, token: adminToken } = await loginAs('admin');
    const sugar = await createItem(admin, adminToken, 'Sugar');

    const { testApp: lead, token: leadToken } = await loginAs('team_lead');
    expect((await takeCount(lead, leadToken, sugar, 20)).status).toBe(200);

    // A parcel going out between counts, the same shape attendance writes.
    const now = new Date().toISOString();
    await db.insert(stockLedger).values({
      id: crypto.randomUUID(),
      stockItemId: sugar,
      quantityDelta: -6,
      movementType: 'parcel_issued',
      parcelId: crypto.randomUUID(),
      sessionId: null,
      actorUserId: null,
      occurredAt: now,
      createdAt: now,
    });

    const response = await correct(lead, leadToken, sugar, 4);

    expect(response.status).toBe(200);
    // 20 (opening balance) - 6 (parcel issued) + 4 (correction) = 18, the
    // sum of everything on the ledger, not a replacement of any of it.
    expect(await response.json()).toEqual({ quantityOnHand: 18 });
  });

  it('rejects a zero quantityDelta with 400', async () => {
    const { testApp: admin, token: adminToken } = await loginAs('admin');
    const sugar = await createItem(admin, adminToken, 'Sugar');

    const { testApp: lead, token: leadToken } = await loginAs('team_lead');
    const response = await correct(lead, leadToken, sugar, 0);

    expect(response.status).toBe(400);
  });

  it('404s an unknown stock item', async () => {
    const { testApp: lead, token: leadToken } = await loginAs('team_lead');

    const response = await correct(lead, leadToken, crypto.randomUUID(), 5);

    expect(response.status).toBe(404);
  });

  it('lets an admin apply a correction, the same as the stock take it belongs with', async () => {
    const { testApp: admin, token: adminToken } = await loginAs('admin');
    const sugar = await createItem(admin, adminToken, 'Sugar');

    const response = await correct(admin, adminToken, sugar, 5);

    expect(response.status).toBe(200);
    const body: { quantityOnHand: number } = await response.json();
    expect(body.quantityOnHand).toBe(5);
  });

  it('refuses an unauthenticated request', async () => {
    const { testApp: admin, token: adminToken } = await loginAs('admin');
    const sugar = await createItem(admin, adminToken, 'Sugar');

    const response = await admin.request(`/api/v1/stock/items/${sugar}/corrections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantityDelta: 5 }),
    });

    expect(response.status).toBe(401);
  });

  it('is deleted, like everything else on the item, by a subsequent stock take', async () => {
    const { testApp: admin, token: adminToken } = await loginAs('admin');
    const sugar = await createItem(admin, adminToken, 'Sugar');

    const { testApp: lead, token: leadToken } = await loginAs('team_lead');
    expect((await correct(lead, leadToken, sugar, 5)).status).toBe(200);

    const entriesBefore = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.stockItemId, sugar));
    expect(entriesBefore.map((entry) => entry.movementType)).toEqual(['correction']);

    expect((await takeCount(lead, leadToken, sugar, 12)).status).toBe(200);

    const entriesAfter = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.stockItemId, sugar));
    // The "two deletes" rule deletes by stock_item_id regardless of
    // movement type — the correction row does not survive a fresh count.
    expect(entriesAfter).toHaveLength(1);
    expect(entriesAfter[0]?.movementType).toBe('opening_balance');
    expect(entriesAfter[0]?.quantityDelta).toBe(12);
  });
});
