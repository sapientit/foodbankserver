import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { crateMembers, crates } from '../src/db/schema/crates.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { NON_PERISHABLE_GROUPING_ID } from '../src/modules/stock/stock.service.ts';
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

async function createItem(
  testApp: TestApp,
  token: string,
  name: string,
  shelfNumber: string,
): Promise<string> {
  const response = await testApp.request('/api/v1/stock/items', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ name, category: 'Tinned Goods', shelfNumber }),
  });
  expect(response.status).toBe(201);
  const { id }: { id: string } = await response.json();
  return id;
}

interface CrateMemberInput {
  readonly stockItemId: string;
  readonly stockCompositionPercent: number;
  readonly shoppingCompositionPercent: number;
}

interface CrateBody {
  readonly name: string;
  readonly shelfKey: string;
  readonly groupingId: string;
  readonly sizePerCrate: number;
  readonly members: CrateMemberInput[];
}

interface CrateResponseBody {
  readonly id: string;
  readonly name: string;
  readonly shelfKey: string;
  readonly groupingId: string;
  readonly sizePerCrate: number;
  readonly members: CrateMemberInput[];
}

async function createCrateResponse(
  testApp: TestApp,
  token: string,
  body: CrateBody,
): Promise<Response> {
  return testApp.request('/api/v1/stock/crates', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
}

async function createCrate(
  testApp: TestApp,
  token: string,
  body: CrateBody,
): Promise<CrateResponseBody> {
  const response = await createCrateResponse(testApp, token, body);
  expect(response.status).toBe(201);
  return response.json();
}

async function patchCrate(
  testApp: TestApp,
  token: string,
  id: string,
  body: Partial<CrateBody>,
): Promise<Response> {
  return testApp.request(`/api/v1/stock/crates/${id}`, {
    method: 'PATCH',
    headers: json(token),
    body: JSON.stringify(body),
  });
}

async function deleteCrate(testApp: TestApp, token: string, id: string): Promise<Response> {
  return testApp.request(`/api/v1/stock/crates/${id}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}

async function listCrates(testApp: TestApp, token: string): Promise<CrateResponseBody[]> {
  const response = await testApp.request('/api/v1/stock/crates', { headers: authHeaders(token) });
  expect(response.status).toBe(200);
  const { items }: { items: CrateResponseBody[] } = await response.json();
  return items;
}

function membersOf(items: CrateResponseBody[], crateId: string): CrateMemberInput[] {
  const crate = items.find((entry) => entry.id === crateId);
  if (crate === undefined) throw new Error(`crate ${crateId} not found in list`);
  return [...crate.members].sort((a, b) => a.stockItemId.localeCompare(b.stockItemId));
}

beforeEach(async () => {
  await db.delete(crateMembers);
  await db.delete(crates);
  await db.delete(stockLedger);
  await db.delete(stockItems);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('creating a crate', () => {
  it('creates a crate with two members and reads it back with its members', async () => {
    const { testApp, token } = await loginAs('admin');
    const item1 = await createItem(testApp, token, 'Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Item Two', 'C1');

    const created = await createCrate(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 60, shoppingCompositionPercent: 70 },
        { stockItemId: item2, stockCompositionPercent: 40, shoppingCompositionPercent: 30 },
      ],
    });

    expect(created).toMatchObject({
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
    });
    expect([...created.members].sort((a, b) => a.stockItemId.localeCompare(b.stockItemId))).toEqual(
      [
        { stockItemId: item1, stockCompositionPercent: 60, shoppingCompositionPercent: 70 },
        { stockItemId: item2, stockCompositionPercent: 40, shoppingCompositionPercent: 30 },
      ].sort((a, b) => a.stockItemId.localeCompare(b.stockItemId)),
    );

    const listed = await listCrates(testApp, token);
    expect(listed.map((crate) => crate.id)).toContain(created.id);
    expect(membersOf(listed, created.id)).toEqual(
      membersOf([created], created.id), // same shape, sorted the same way
    );
  });

  it('carries a shelfKey a client can interleave with stock items by a plain string sort', async () => {
    const { testApp, token } = await loginAs('admin');
    const before = await createItem(testApp, token, 'Before', 'B2');
    const item1 = await createItem(testApp, token, 'Item One', 'C10');
    const item2 = await createItem(testApp, token, 'Item Two', 'C10');
    const after = await createItem(testApp, token, 'After', 'D1');

    const crate = await createCrate(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C10',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 60, shoppingCompositionPercent: 70 },
        { stockItemId: item2, stockCompositionPercent: 40, shoppingCompositionPercent: 30 },
      ],
    });

    const itemsResponse = await testApp.request('/api/v1/stock/items?order=shelf', {
      headers: authHeaders(token),
    });
    const { items: stockItems2 }: { items: { id: string; name: string; shelfNumber: string }[] } =
      await itemsResponse.json();

    const merged = [
      ...stockItems2
        .filter((item) => item.id === before || item.id === after)
        .map((item) => ({ name: item.name, key: item.shelfNumber })),
      { name: 'Mixed Crate', key: crate.shelfKey },
    ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    expect(merged.map((entry) => entry.name)).toEqual(['Before', 'Mixed Crate', 'After']);
  });

  it('rejects fewer than two members', async () => {
    const { testApp, token } = await loginAs('admin');
    const item1 = await createItem(testApp, token, 'Item One', 'C1');

    const response = await createCrateResponse(testApp, token, {
      name: 'Solo Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 100, shoppingCompositionPercent: 100 },
      ],
    });

    expect(response.status).toBe(400);
  });

  it('creates a crate at the maximum member count without hitting a bound-parameter limit', async () => {
    // Regression: MAX_CRATE_MEMBERS exists specifically so a schema-valid
    // member count never blows D1's 100-bound-parameter-per-statement limit
    // (4 params per member row). This is the boundary the limit is set from.
    const { testApp, token } = await loginAs('admin');
    const itemIds: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      itemIds.push(await createItem(testApp, token, `Item ${String(index)}`, 'C1'));
    }

    const created = await createCrate(testApp, token, {
      name: 'Full Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 100,
      members: itemIds.map((stockItemId) => ({
        stockItemId,
        stockCompositionPercent: 5,
        shoppingCompositionPercent: 5,
      })),
    });

    expect(created.members).toHaveLength(20);
  });

  it('rejects a percentage table that does not sum to 100', async () => {
    const { testApp, token } = await loginAs('admin');
    const item1 = await createItem(testApp, token, 'Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Item Two', 'C1');

    const response = await createCrateResponse(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 30, shoppingCompositionPercent: 30 },
        { stockItemId: item2, stockCompositionPercent: 30, shoppingCompositionPercent: 30 },
      ],
    });

    expect(response.status).toBe(400);
  });

  it('rejects an all-zero percentage table rather than falling back to it', async () => {
    const { testApp, token } = await loginAs('admin');
    const item1 = await createItem(testApp, token, 'Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Item Two', 'C1');

    const response = await createCrateResponse(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 0, shoppingCompositionPercent: 0 },
        { stockItemId: item2, stockCompositionPercent: 0, shoppingCompositionPercent: 0 },
      ],
    });

    expect(response.status).toBe(400);
  });

  it('rejects the same stock item appearing twice among a crate’s members', async () => {
    const { testApp, token } = await loginAs('admin');
    const item1 = await createItem(testApp, token, 'Item One', 'C1');

    const response = await createCrateResponse(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        { stockItemId: item1, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
      ],
    });

    expect(response.status).toBe(400);
  });

  it('rejects an unknown groupingId with 400', async () => {
    const { testApp, token } = await loginAs('admin');
    const item1 = await createItem(testApp, token, 'Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Item Two', 'C1');

    const response = await createCrateResponse(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: crypto.randomUUID(),
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        { stockItemId: item2, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
      ],
    });

    expect(response.status).toBe(400);
  });

  it('rejects an unknown member stockItemId with 400', async () => {
    const { testApp, token } = await loginAs('admin');
    const item1 = await createItem(testApp, token, 'Item One', 'C1');

    const response = await createCrateResponse(testApp, token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        {
          stockItemId: crypto.randomUUID(),
          stockCompositionPercent: 50,
          shoppingCompositionPercent: 50,
        },
      ],
    });

    expect(response.status).toBe(400);
  });

  it('rejects a second crate claiming the same shelfKey with 409', async () => {
    const { testApp, token } = await loginAs('admin');
    const item1 = await createItem(testApp, token, 'Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Item Two', 'C1');
    const item3 = await createItem(testApp, token, 'Item Three', 'C1');
    const item4 = await createItem(testApp, token, 'Item Four', 'C1');

    await createCrate(testApp, token, {
      name: 'First Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        { stockItemId: item2, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
      ],
    });

    const second = await createCrateResponse(testApp, token, {
      name: 'Second Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 5,
      members: [
        { stockItemId: item3, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        { stockItemId: item4, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
      ],
    });

    expect(second.status).toBe(409);
  });
});

describe('amending a crate', () => {
  it('replaces members wholesale on patch — old members gone, only the new set present', async () => {
    const { testApp, token } = await loginAs('admin');
    const item1 = await createItem(testApp, token, 'Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Item Two', 'C1');
    const item3 = await createItem(testApp, token, 'Item Three', 'C1');
    const item4 = await createItem(testApp, token, 'Item Four', 'C1');

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

    const patched = await patchCrate(testApp, token, crate.id, {
      members: [
        { stockItemId: item3, stockCompositionPercent: 30, shoppingCompositionPercent: 30 },
        { stockItemId: item4, stockCompositionPercent: 70, shoppingCompositionPercent: 70 },
      ],
    });
    expect(patched.status).toBe(200);
    const body: CrateResponseBody = await patched.json();
    expect(body.members.map((m) => m.stockItemId).sort()).toEqual([item3, item4].sort());

    const listed = await listCrates(testApp, token);
    expect(membersOf(listed, crate.id).map((m) => m.stockItemId)).toEqual([item3, item4].sort());
  });

  it('renames a crate on patch without touching its members', async () => {
    const { testApp, token } = await loginAs('admin');
    const item1 = await createItem(testApp, token, 'Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Item Two', 'C1');

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

    const patched = await patchCrate(testApp, token, crate.id, { name: 'Renamed Crate' });
    expect(patched.status).toBe(200);
    const body: CrateResponseBody = await patched.json();
    expect(body.name).toBe('Renamed Crate');
    expect(body.members.map((m) => m.stockItemId).sort()).toEqual([item1, item2].sort());
  });

  it('404s patching an unknown crate id', async () => {
    const { testApp, token } = await loginAs('admin');

    const response = await patchCrate(testApp, token, crypto.randomUUID(), { name: 'Anything' });
    expect(response.status).toBe(404);
  });
});

describe('deleting a crate', () => {
  it('is idempotent — deleting an already-gone id still returns 204', async () => {
    const { testApp, token } = await loginAs('admin');
    const item1 = await createItem(testApp, token, 'Item One', 'C1');
    const item2 = await createItem(testApp, token, 'Item Two', 'C1');

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

    const first = await deleteCrate(testApp, token, crate.id);
    expect(first.status).toBe(204);

    const second = await deleteCrate(testApp, token, crate.id);
    expect(second.status).toBe(204);

    expect((await listCrates(testApp, token)).map((c) => c.id)).not.toContain(crate.id);
  });
});

describe('crate authorisation', () => {
  it('lets a team lead read crates but refuses create, patch and delete', async () => {
    const admin = await loginAs('admin');
    const item1 = await createItem(admin.testApp, admin.token, 'Item One', 'C1');
    const item2 = await createItem(admin.testApp, admin.token, 'Item Two', 'C1');
    const crate = await createCrate(admin.testApp, admin.token, {
      name: 'Mixed Crate',
      shelfKey: 'C1',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: [
        { stockItemId: item1, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        { stockItemId: item2, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
      ],
    });

    const { testApp, token } = await loginAs('team_lead');

    const list = await testApp.request('/api/v1/stock/crates', { headers: authHeaders(token) });
    expect(list.status).toBe(200);

    const post = await createCrateResponse(testApp, token, {
      name: 'Another Crate',
      shelfKey: 'C2',
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 5,
      members: [
        { stockItemId: item1, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
        { stockItemId: item2, stockCompositionPercent: 50, shoppingCompositionPercent: 50 },
      ],
    });
    expect(post.status).toBe(403);

    const patched = await patchCrate(testApp, token, crate.id, { name: 'Renamed by team lead' });
    expect(patched.status).toBe(403);

    const deleted = await deleteCrate(testApp, token, crate.id);
    expect(deleted.status).toBe(403);
  });
});
