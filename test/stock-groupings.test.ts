import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { stockTakeGroupings } from '../src/db/schema/crates.ts';
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

async function createGrouping(testApp: TestApp, token: string, name: string): Promise<Response> {
  return testApp.request('/api/v1/stock/groupings', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ name }),
  });
}

async function renameGrouping(
  testApp: TestApp,
  token: string,
  id: string,
  name: string,
): Promise<Response> {
  return testApp.request(`/api/v1/stock/groupings/${id}`, {
    method: 'PATCH',
    headers: json(token),
    body: JSON.stringify({ name }),
  });
}

async function listGroupings(testApp: TestApp, token: string): Promise<Response> {
  return testApp.request('/api/v1/stock/groupings', { headers: authHeaders(token) });
}

beforeEach(async () => {
  // The seeded "Non-perishable" row is part of this table too; clearing it
  // here is safe because this file only exercises grouping CRUD, never a
  // dependency on the seeded id.
  await db.delete(stockTakeGroupings);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('stock-take groupings', () => {
  it('creates, lists and renames a grouping', async () => {
    const { testApp, token } = await loginAs('admin');

    const created = await createGrouping(testApp, token, 'Fresh');
    expect(created.status).toBe(201);
    const body: { id: string; name: string } = await created.json();
    expect(body.name).toBe('Fresh');

    const listed = await listGroupings(testApp, token);
    expect(listed.status).toBe(200);
    const { items }: { items: { id: string; name: string }[] } = await listed.json();
    expect(items).toEqual([{ id: body.id, name: 'Fresh' }]);

    const renamed = await renameGrouping(testApp, token, body.id, 'Fresh Produce');
    expect(renamed.status).toBe(200);
    const renamedBody: { id: string; name: string } = await renamed.json();
    expect(renamedBody).toEqual({ id: body.id, name: 'Fresh Produce' });

    const relisted = await listGroupings(testApp, token);
    const { items: relistedItems }: { items: { name: string }[] } = await relisted.json();
    expect(relistedItems.map((item) => item.name)).toEqual(['Fresh Produce']);
  });

  it('rejects a duplicate grouping name on create with 409', async () => {
    const { testApp, token } = await loginAs('admin');
    await createGrouping(testApp, token, 'Fresh');

    const dup = await createGrouping(testApp, token, 'Fresh');
    expect(dup.status).toBe(409);
  });

  it('rejects a duplicate grouping name on rename with 409', async () => {
    const { testApp, token } = await loginAs('admin');
    await createGrouping(testApp, token, 'Fresh');
    const created = await createGrouping(testApp, token, 'Frozen');
    const { id }: { id: string } = await created.json();

    const renamed = await renameGrouping(testApp, token, id, 'Fresh');
    expect(renamed.status).toBe(409);
  });

  it('404s renaming an unknown grouping id', async () => {
    const { testApp, token } = await loginAs('admin');

    const response = await renameGrouping(testApp, token, crypto.randomUUID(), 'Anything');
    expect(response.status).toBe(404);
  });

  it('lets a team lead read groupings but not create or rename them', async () => {
    const admin = await loginAs('admin');
    const created = await createGrouping(admin.testApp, admin.token, 'Fresh');
    const { id }: { id: string } = await created.json();

    const { testApp, token } = await loginAs('team_lead');

    const list = await listGroupings(testApp, token);
    expect(list.status).toBe(200);

    const post = await createGrouping(testApp, token, 'Frozen');
    expect(post.status).toBe(403);

    const patched = await renameGrouping(testApp, token, id, 'Renamed');
    expect(patched.status).toBe(403);
  });

  it('lets an admin both read and write', async () => {
    const { testApp, token } = await loginAs('admin');

    expect((await listGroupings(testApp, token)).status).toBe(200);
    expect((await createGrouping(testApp, token, 'Fresh')).status).toBe(201);
  });
});
