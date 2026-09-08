import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { crateMembers, crates } from '../src/db/schema/crates.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { targetStockLists } from '../src/db/schema/target-stock-lists.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { NON_PERISHABLE_GROUPING_ID } from '../src/modules/stock/stock.service.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';

const db = createDatabase(env.DB);

async function createStockItem(
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

async function createCrateOf(
  testApp: TestApp,
  token: string,
  shelfNumber: string,
  memberIds: readonly string[],
): Promise<string> {
  const share = Math.floor(100 / memberIds.length);
  const response = await testApp.request('/api/v1/stock/crates', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      name: 'Mixed Crate',
      shelfKey: shelfNumber,
      groupingId: NON_PERISHABLE_GROUPING_ID,
      sizePerCrate: 10,
      members: memberIds.map((stockItemId, index) => ({
        stockItemId,
        stockCompositionPercent: index === memberIds.length - 1 ? 100 - share * index : share,
        shoppingCompositionPercent: index === memberIds.length - 1 ? 100 - share * index : share,
      })),
    }),
  });
  expect(response.status).toBe(201);
  const { id }: { id: string } = await response.json();
  return id;
}

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

async function loginAs(role: 'admin' | 'team_lead'): Promise<{ testApp: TestApp; token: string }> {
  const testApp = buildTestApp();
  const { accessToken } = await devLogin(testApp, { email: `${role}@foodbank.org`, role });
  return { testApp, token: accessToken };
}

async function create(
  testApp: TestApp,
  token: string,
  body: {
    name: string;
    lines: { kind: 'item'; stockItemId: string; name: string; targetQuantity: number }[];
  },
): Promise<Response> {
  return testApp.request('/api/v1/target-stock-lists', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
}

async function patch(
  testApp: TestApp,
  token: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return testApp.request(`/api/v1/target-stock-lists/${id}`, {
    method: 'PATCH',
    headers: json(token),
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await db.delete(targetStockLists);
  await db.delete(crateMembers);
  await db.delete(crates);
  await db.delete(stockLedger);
  await db.delete(stockItems);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('target stock lists', () => {
  it('creates, lists and reads back a list with its lines', async () => {
    const { testApp, token } = await loginAs('admin');

    const created = await create(testApp, token, {
      name: 'Standard week',
      lines: [{ kind: 'item', stockItemId: 'stock-1', name: 'Beans', targetQuantity: 20 }],
    });
    expect(created.status).toBe(201);
    const body: { id: string; name: string; lines: unknown[] } = await created.json();
    expect(body.name).toBe('Standard week');
    expect(body.lines).toEqual([
      { kind: 'item', stockItemId: 'stock-1', name: 'Beans', targetQuantity: 20 },
    ]);

    const listed = await testApp.request('/api/v1/target-stock-lists', { headers: json(token) });
    expect(listed.status).toBe(200);
    const { targetStockLists: lists }: { targetStockLists: { id: string }[] } = await listed.json();
    expect(lists.map((list) => list.id)).toContain(body.id);
  });

  it('stores lines verbatim: an unknown or retired stockItemId is accepted, not rejected', async () => {
    const { testApp, token } = await loginAs('admin');

    const response = await create(testApp, token, {
      name: 'Christmas',
      lines: [
        {
          kind: 'item',
          stockItemId: 'does-not-exist',
          name: 'Whatever it was called',
          targetQuantity: 5,
        },
      ],
    });

    expect(response.status).toBe(201);
    const body: {
      lines: { kind: 'item'; stockItemId: string; name: string; targetQuantity: number }[];
    } = await response.json();
    expect(body.lines).toEqual([
      {
        kind: 'item',
        stockItemId: 'does-not-exist',
        name: 'Whatever it was called',
        targetQuantity: 5,
      },
    ]);
  });

  it('does not rewrite a stale name snapshot on its own — a patch that omits lines leaves them untouched', async () => {
    const { testApp, token } = await loginAs('admin');

    const created = await create(testApp, token, {
      name: 'Standard week',
      lines: [{ kind: 'item', stockItemId: 'stock-1', name: 'Old name', targetQuantity: 5 }],
    });
    const { id }: { id: string } = await created.json();

    const renamed = await patch(testApp, token, id, { name: 'Standard week (renamed)' });
    expect(renamed.status).toBe(200);
    const body: { name: string; lines: { name: string }[] } = await renamed.json();
    expect(body.name).toBe('Standard week (renamed)');
    expect(body.lines).toEqual([
      { kind: 'item', stockItemId: 'stock-1', name: 'Old name', targetQuantity: 5 },
    ]);
  });

  it('replaces lines wholesale on patch rather than merging', async () => {
    const { testApp, token } = await loginAs('admin');

    const created = await create(testApp, token, {
      name: 'Standard week',
      lines: [
        { kind: 'item', stockItemId: 'stock-1', name: 'Beans', targetQuantity: 5 },
        { kind: 'item', stockItemId: 'stock-2', name: 'Pasta', targetQuantity: 3 },
      ],
    });
    const { id }: { id: string } = await created.json();

    const updated = await patch(testApp, token, id, {
      lines: [{ kind: 'item', stockItemId: 'stock-2', name: 'Pasta', targetQuantity: 8 }],
    });

    expect(updated.status).toBe(200);
    const body: { lines: unknown[] } = await updated.json();
    expect(body.lines).toEqual([
      { kind: 'item', stockItemId: 'stock-2', name: 'Pasta', targetQuantity: 8 },
    ]);
  });

  it('rejects a duplicate name on create with 409', async () => {
    const { testApp, token } = await loginAs('admin');
    await create(testApp, token, { name: 'Standard week', lines: [] });

    const dup = await create(testApp, token, { name: 'Standard week', lines: [] });
    expect(dup.status).toBe(409);
  });

  it('rejects a duplicate name on patch with 409', async () => {
    const { testApp, token } = await loginAs('admin');
    await create(testApp, token, { name: 'Standard week', lines: [] });
    const created = await create(testApp, token, { name: 'Christmas', lines: [] });
    const { id }: { id: string } = await created.json();

    const renamed = await patch(testApp, token, id, { name: 'Standard week' });
    expect(renamed.status).toBe(409);
  });

  it('rejects a targetQuantity of 0', async () => {
    const { testApp, token } = await loginAs('admin');

    const response = await create(testApp, token, {
      name: 'Standard week',
      lines: [{ kind: 'item', stockItemId: 'stock-1', name: 'Beans', targetQuantity: 0 }],
    });

    expect(response.status).toBe(400);
  });

  it('404s a patch to an unknown id', async () => {
    const { testApp, token } = await loginAs('admin');
    const response = await patch(testApp, token, crypto.randomUUID(), { name: 'Anything' });
    expect(response.status).toBe(404);
  });

  it('deletes idempotently — deleting an already-gone id still returns 204', async () => {
    const { testApp, token } = await loginAs('admin');
    const created = await create(testApp, token, { name: 'Standard week', lines: [] });
    const { id }: { id: string } = await created.json();

    const first = await testApp.request(`/api/v1/target-stock-lists/${id}`, {
      method: 'DELETE',
      headers: json(token),
    });
    expect(first.status).toBe(204);

    const second = await testApp.request(`/api/v1/target-stock-lists/${id}`, {
      method: 'DELETE',
      headers: json(token),
    });
    expect(second.status).toBe(204);
  });

  it('round-trips a crate-kind line through create, list and patch', async () => {
    const { testApp, token } = await loginAs('admin');

    const created = await testApp.request('/api/v1/target-stock-lists', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Crate list',
        lines: [
          { kind: 'crate', crateId: 'crate-1', crateName: 'Mixed Crate', targetQuantity: 1.5 },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const body: { id: string; lines: unknown[] } = await created.json();
    expect(body.lines).toEqual([
      { kind: 'crate', crateId: 'crate-1', crateName: 'Mixed Crate', targetQuantity: 1.5 },
    ]);

    const listed = await testApp.request('/api/v1/target-stock-lists', { headers: json(token) });
    const { targetStockLists: lists }: { targetStockLists: { id: string; lines: unknown[] }[] } =
      await listed.json();
    const found = lists.find((list) => list.id === body.id);
    expect(found?.lines).toEqual([
      { kind: 'crate', crateId: 'crate-1', crateName: 'Mixed Crate', targetQuantity: 1.5 },
    ]);

    const patched = await patch(testApp, token, body.id, {
      lines: [{ kind: 'crate', crateId: 'crate-1', crateName: 'Mixed Crate', targetQuantity: 2 }],
    });
    expect(patched.status).toBe(200);
    const patchedBody: { lines: unknown[] } = await patched.json();
    expect(patchedBody.lines).toEqual([
      { kind: 'crate', crateId: 'crate-1', crateName: 'Mixed Crate', targetQuantity: 2 },
    ]);
  });

  it('mixes an item line and a crate line in the same list', async () => {
    const { testApp, token } = await loginAs('admin');

    const created = await testApp.request('/api/v1/target-stock-lists', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Mixed list',
        lines: [
          { kind: 'item', stockItemId: 'stock-1', name: 'Beans', targetQuantity: 5 },
          { kind: 'crate', crateId: 'crate-1', crateName: 'Mixed Crate', targetQuantity: 2.5 },
        ],
      }),
    });

    expect(created.status).toBe(201);
    const body: { lines: unknown[] } = await created.json();
    expect(body.lines).toEqual([
      { kind: 'item', stockItemId: 'stock-1', name: 'Beans', targetQuantity: 5 },
      { kind: 'crate', crateId: 'crate-1', crateName: 'Mixed Crate', targetQuantity: 2.5 },
    ]);
  });

  it('reads a line saved before `kind` existed back with kind: item filled in', async () => {
    const { testApp, token } = await loginAs('admin');
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    // Written directly, bypassing the service, to simulate a row saved before
    // the crate-line addition — its linesJson has no `kind` field at all.
    await db.insert(targetStockLists).values({
      id,
      name: 'Old-shape list',
      linesJson: JSON.stringify([{ stockItemId: 'x', name: 'Beans', targetQuantity: 5 }]),
      createdAt: now,
      updatedAt: now,
    });

    const response = await testApp.request('/api/v1/target-stock-lists', { headers: json(token) });
    expect(response.status).toBe(200);
    const { targetStockLists: lists }: { targetStockLists: { id: string; lines: unknown[] }[] } =
      await response.json();
    const found = lists.find((list) => list.id === id);
    expect(found?.lines).toEqual([
      { kind: 'item', stockItemId: 'x', name: 'Beans', targetQuantity: 5 },
    ]);
  });

  it('lets a team lead read but not maintain', async () => {
    const admin = await loginAs('admin');
    const created = await create(admin.testApp, admin.token, {
      name: 'Standard week',
      lines: [],
    });
    const { id }: { id: string } = await created.json();

    const { testApp, token } = await loginAs('team_lead');

    const list = await testApp.request('/api/v1/target-stock-lists', { headers: json(token) });
    expect(list.status).toBe(200);

    const post = await create(testApp, token, { name: 'Team lead list', lines: [] });
    expect(post.status).toBe(403);

    const patched = await patch(testApp, token, id, { name: 'Renamed by team lead' });
    expect(patched.status).toBe(403);

    const deleted = await testApp.request(`/api/v1/target-stock-lists/${id}`, {
      method: 'DELETE',
      headers: json(token),
    });
    expect(deleted.status).toBe(403);
  });
});

describe('a crate member cannot be given an individual target', () => {
  it('refuses an item-kind line naming a current crate member on create, with 422', async () => {
    const { testApp, token } = await loginAs('admin');
    const member = await createStockItem(testApp, token, 'Crate Item', 'C1');
    const otherMember = await createStockItem(testApp, token, 'Crate Item Two', 'C1');
    await createCrateOf(testApp, token, 'C1', [member, otherMember]);

    const response = await create(testApp, token, {
      name: 'Standard week',
      lines: [{ kind: 'item', stockItemId: member, name: 'Crate Item', targetQuantity: 5 }],
    });

    expect(response.status).toBe(422);
    const listed = await testApp.request('/api/v1/target-stock-lists', { headers: json(token) });
    const { targetStockLists: lists }: { targetStockLists: unknown[] } = await listed.json();
    expect(lists).toEqual([]);
  });

  it('refuses the same line on a patch that sends lines, with 422', async () => {
    const { testApp, token } = await loginAs('admin');
    const member = await createStockItem(testApp, token, 'Crate Item', 'C1');
    const otherMember = await createStockItem(testApp, token, 'Crate Item Two', 'C1');
    await createCrateOf(testApp, token, 'C1', [member, otherMember]);

    const created = await create(testApp, token, { name: 'Standard week', lines: [] });
    const { id }: { id: string } = await created.json();

    const response = await patch(testApp, token, id, {
      lines: [{ kind: 'item', stockItemId: member, name: 'Crate Item', targetQuantity: 5 }],
    });

    expect(response.status).toBe(422);
  });

  it('does not retroactively refuse a line already stored before the item became a crate member', async () => {
    const { testApp, token } = await loginAs('admin');
    const member = await createStockItem(testApp, token, 'Future Crate Item', 'C1');
    const otherMember = await createStockItem(testApp, token, 'Future Crate Item Two', 'C1');

    // The individual target is saved first, while the item is not yet a
    // crate member.
    const created = await create(testApp, token, {
      name: 'Standard week',
      lines: [{ kind: 'item', stockItemId: member, name: 'Future Crate Item', targetQuantity: 5 }],
    });
    expect(created.status).toBe(201);
    const { id }: { id: string } = await created.json();

    await createCrateOf(testApp, token, 'C1', [member, otherMember]);

    // A patch that renames the list, without touching `lines`, must not be
    // refused just because the stored line now names a crate member.
    const renamed = await patch(testApp, token, id, { name: 'Standard week (renamed)' });
    expect(renamed.status).toBe(200);
    const body: { name: string; lines: unknown[] } = await renamed.json();
    expect(body.lines).toEqual([
      { kind: 'item', stockItemId: member, name: 'Future Crate Item', targetQuantity: 5 },
    ]);
  });

  it('does not affect a crate-kind line naming the same crate', async () => {
    const { testApp, token } = await loginAs('admin');
    const member = await createStockItem(testApp, token, 'Crate Item', 'C1');
    const otherMember = await createStockItem(testApp, token, 'Crate Item Two', 'C1');
    const crateId = await createCrateOf(testApp, token, 'C1', [member, otherMember]);

    const response = await testApp.request('/api/v1/target-stock-lists', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        name: 'Standard week',
        lines: [{ kind: 'crate', crateId, crateName: 'Mixed Crate', targetQuantity: 1 }],
      }),
    });

    expect(response.status).toBe(201);
  });
});
