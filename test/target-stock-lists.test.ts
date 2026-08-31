import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { targetStockLists } from '../src/db/schema/target-stock-lists.ts';
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

async function create(
  testApp: TestApp,
  token: string,
  body: { name: string; lines: { stockItemId: string; name: string; targetQuantity: number }[] },
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
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('target stock lists', () => {
  it('creates, lists and reads back a list with its lines', async () => {
    const { testApp, token } = await loginAs('admin');

    const created = await create(testApp, token, {
      name: 'Standard week',
      lines: [{ stockItemId: 'stock-1', name: 'Beans', targetQuantity: 20 }],
    });
    expect(created.status).toBe(201);
    const body: { id: string; name: string; lines: unknown[] } = await created.json();
    expect(body.name).toBe('Standard week');
    expect(body.lines).toEqual([{ stockItemId: 'stock-1', name: 'Beans', targetQuantity: 20 }]);

    const listed = await testApp.request('/api/v1/target-stock-lists', { headers: json(token) });
    expect(listed.status).toBe(200);
    const { targetStockLists: lists }: { targetStockLists: { id: string }[] } = await listed.json();
    expect(lists.map((list) => list.id)).toContain(body.id);
  });

  it('stores lines verbatim: an unknown or retired stockItemId is accepted, not rejected', async () => {
    const { testApp, token } = await loginAs('admin');

    const response = await create(testApp, token, {
      name: 'Christmas',
      lines: [{ stockItemId: 'does-not-exist', name: 'Whatever it was called', targetQuantity: 5 }],
    });

    expect(response.status).toBe(201);
    const body: { lines: { stockItemId: string; name: string; targetQuantity: number }[] } =
      await response.json();
    expect(body.lines).toEqual([
      { stockItemId: 'does-not-exist', name: 'Whatever it was called', targetQuantity: 5 },
    ]);
  });

  it('does not rewrite a stale name snapshot on its own — a patch that omits lines leaves them untouched', async () => {
    const { testApp, token } = await loginAs('admin');

    const created = await create(testApp, token, {
      name: 'Standard week',
      lines: [{ stockItemId: 'stock-1', name: 'Old name', targetQuantity: 5 }],
    });
    const { id }: { id: string } = await created.json();

    const renamed = await patch(testApp, token, id, { name: 'Standard week (renamed)' });
    expect(renamed.status).toBe(200);
    const body: { name: string; lines: { name: string }[] } = await renamed.json();
    expect(body.name).toBe('Standard week (renamed)');
    expect(body.lines).toEqual([{ stockItemId: 'stock-1', name: 'Old name', targetQuantity: 5 }]);
  });

  it('replaces lines wholesale on patch rather than merging', async () => {
    const { testApp, token } = await loginAs('admin');

    const created = await create(testApp, token, {
      name: 'Standard week',
      lines: [
        { stockItemId: 'stock-1', name: 'Beans', targetQuantity: 5 },
        { stockItemId: 'stock-2', name: 'Pasta', targetQuantity: 3 },
      ],
    });
    const { id }: { id: string } = await created.json();

    const updated = await patch(testApp, token, id, {
      lines: [{ stockItemId: 'stock-2', name: 'Pasta', targetQuantity: 8 }],
    });

    expect(updated.status).toBe(200);
    const body: { lines: unknown[] } = await updated.json();
    expect(body.lines).toEqual([{ stockItemId: 'stock-2', name: 'Pasta', targetQuantity: 8 }]);
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
      lines: [{ stockItemId: 'stock-1', name: 'Beans', targetQuantity: 0 }],
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
