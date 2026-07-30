import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, seedUser, type TestApp } from './helpers/app.ts';

const db = createDatabase(env.DB);

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

async function createUser(
  testApp: TestApp,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return testApp.request('/api/v1/users', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
}

async function patchUser(
  testApp: TestApp,
  token: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return testApp.request(`/api/v1/users/${id}`, {
    method: 'PATCH',
    headers: json(token),
    body: JSON.stringify(body),
  });
}

describe('user maintenance', () => {
  let testApp: TestApp;
  let adminToken: string;
  let adminId: string;

  beforeEach(async () => {
    // Storage isolation is per test file, not per test.
    await db.delete(refreshTokens);
    await db.delete(users);

    testApp = buildTestApp();
    const login = await devLogin(testApp, { email: 'admin@foodbank.org' });
    adminToken = login.accessToken;
    adminId = login.userId;
  });

  it('creates a user an admin can then log in as', async () => {
    const created = await createUser(testApp, adminToken, {
      email: 'Lead@FoodBank.org',
      displayName: 'Sam Lead',
      role: 'team_lead',
    });

    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      email: 'lead@foodbank.org', // normalised, because logins are
      displayName: 'Sam Lead',
      role: 'team_lead',
      isActive: true,
      lastLoginAt: null,
    });

    const login = await testApp.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'lead@foodbank.org' }),
    });

    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ user: { role: 'team_lead' } });
  });

  it('refuses a second user with the same email address', async () => {
    const body = { email: 'lead@foodbank.org', displayName: 'Sam', role: 'team_lead' };
    expect((await createUser(testApp, adminToken, body)).status).toBe(201);

    const duplicate = await createUser(testApp, adminToken, {
      ...body,
      displayName: 'Someone else',
    });

    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('never offers a role the system does not use', async () => {
    const response = await createUser(testApp, adminToken, {
      email: 'volunteer@foodbank.org',
      displayName: 'Vol',
      role: 'volunteer',
    });

    expect(response.status).toBe(400);
  });

  it('lists active users by default and retired ones on request', async () => {
    await seedUser({ email: 'retired@foodbank.org', isActive: 0, role: 'team_lead' });

    const active = await testApp.request('/api/v1/users', { headers: authHeaders(adminToken) });
    const all = await testApp.request('/api/v1/users?includeInactive=true', {
      headers: authHeaders(adminToken),
    });

    const emailsOf = async (response: Response): Promise<string[]> => {
      const body: { users: { email: string }[] } = await response.json();
      return body.users.map((user) => user.email);
    };

    expect(await emailsOf(active)).toEqual(['admin@foodbank.org']);
    expect(await emailsOf(all)).toEqual(['admin@foodbank.org', 'retired@foodbank.org']);
  });

  it('changes a role, and the new role takes effect at the next login', async () => {
    const leadId = await seedUser({ email: 'lead@foodbank.org', role: 'team_lead' });

    const response = await patchUser(testApp, adminToken, leadId, { role: 'admin' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ role: 'admin' });

    const login = await devLogin(testApp, { email: 'lead@foodbank.org' });
    const me = await testApp.request('/api/v1/auth/me', {
      headers: authHeaders(login.accessToken),
    });
    expect(await me.json()).toMatchObject({ role: 'admin' });
  });

  it('deactivating a user stops them logging in', async () => {
    const leadId = await seedUser({ email: 'lead@foodbank.org', role: 'team_lead' });

    expect((await patchUser(testApp, adminToken, leadId, { isActive: false })).status).toBe(200);

    const login = await testApp.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'lead@foodbank.org' }),
    });
    expect(login.status).toBe(403);
  });

  /**
   * The lockout this guards against needs two admins acting at once — or, as
   * here, one acting on an access token minted before they were demoted. A
   * token is good for fifteen minutes and nothing revokes it early, so "they
   * were an admin a moment ago" is a real state, not a contrived one.
   */
  it('refuses to demote the last active admin, even on a still-valid token', async () => {
    const second = await devLogin(testApp, { email: 'second@foodbank.org', role: 'admin' });

    // Two admins, so demoting one is fine.
    expect(
      (await patchUser(testApp, adminToken, second.userId, { role: 'team_lead' })).status,
    ).toBe(200);

    // The demoted admin's token still says admin. Their attempt would leave
    // the food bank with nobody who can administer it.
    const lockout = await patchUser(testApp, second.accessToken, adminId, { role: 'team_lead' });

    expect(lockout.status).toBe(409);
    const [remaining] = await db.select().from(users).where(eq(users.id, adminId));
    expect(remaining?.role).toBe('admin');
  });

  it('refuses to let an admin demote or deactivate themselves', async () => {
    await seedUser({ email: 'second@foodbank.org', role: 'admin' });

    const demote = await patchUser(testApp, adminToken, adminId, { role: 'team_lead' });
    const deactivate = await patchUser(testApp, adminToken, adminId, { isActive: false });

    expect(demote.status).toBe(409);
    expect(deactivate.status).toBe(409);
  });

  it('lets an admin be deactivated while another one remains', async () => {
    const otherAdminId = await seedUser({ email: 'second@foodbank.org', role: 'admin' });

    const response = await patchUser(testApp, adminToken, otherAdminId, { isActive: false });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isActive: false });
  });

  it('reports an unknown user as not found', async () => {
    const response = await patchUser(testApp, adminToken, crypto.randomUUID(), {
      displayName: 'Nobody',
    });

    expect(response.status).toBe(404);
  });

  it('does not expose user administration to a team lead', async () => {
    const lead = await devLogin(testApp, { email: 'lead@foodbank.org', role: 'team_lead' });

    const list = await testApp.request('/api/v1/users', {
      headers: authHeaders(lead.accessToken),
    });
    const create = await createUser(testApp, lead.accessToken, {
      email: 'sneaky@foodbank.org',
      displayName: 'Sneaky',
      role: 'admin',
    });

    expect(list.status).toBe(403);
    expect(create.status).toBe(403);
  });

  it('requires authentication', async () => {
    expect((await testApp.request('/api/v1/users')).status).toBe(401);
  });
});
