import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, cookieHeader, devLogin, seedUser } from './helpers/app.ts';

const db = createDatabase(env.DB);

describe('auth flow', () => {
  beforeEach(async () => {
    // Storage isolation is per test file, not per test.
    await db.delete(refreshTokens);
    await db.delete(users);
  });

  it('signs in an existing user with the role from their record', async () => {
    const testApp = buildTestApp();
    const userId = await seedUser({ email: 'pete@example.org', role: 'team_lead' });

    const { accessToken } = await devLogin(testApp, { email: 'Pete@Example.org' });

    const me = await testApp.request('/api/v1/auth/me', { headers: authHeaders(accessToken) });
    expect(await me.json()).toEqual({
      id: userId,
      email: 'pete@example.org', // normalised to lowercase
      role: 'team_lead',
    });
  });

  it('refuses a login for an email address with no user record', async () => {
    const testApp = buildTestApp();

    const response = await testApp.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'stranger@example.org' }),
    });

    expect(response.status).toBe(401);
    // Same answer as any other failed login: whether an address is registered
    // here is not something an unauthenticated caller should learn.
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('refuses a login for a deactivated user', async () => {
    const testApp = buildTestApp();
    await seedUser({ email: 'gone@example.org', isActive: 0 });

    const response = await testApp.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'gone@example.org' }),
    });

    expect(response.status).toBe(403);
    expect(await db.select().from(refreshTokens)).toHaveLength(0);
  });

  it('reuses the existing user on a second login rather than duplicating', async () => {
    const testApp = buildTestApp();

    const first = await devLogin(testApp, { email: 'pete@example.org' });
    const second = await devLogin(testApp, { email: 'PETE@example.org' });

    expect(second.userId).toBe(first.userId);
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it('ignores a role sent in the login body — the record decides', async () => {
    const testApp = buildTestApp();
    await seedUser({ email: 'lead@example.org', role: 'team_lead' });

    const response = await testApp.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'lead@example.org', role: 'admin' }),
    });

    expect(await response.json()).toMatchObject({ user: { role: 'team_lead' } });
  });

  it('does not register the dev-login route when AUTH_MODE is google', async () => {
    const testApp = buildTestApp({ bindings: { AUTH_MODE: 'google' } });

    const response = await testApp.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pete@example.org' }),
    });

    expect(response.status).toBe(404);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('never returns the refresh token in the body, only as an HttpOnly cookie', async () => {
    const testApp = buildTestApp();
    await seedUser({ email: 'pete@example.org' });

    const response = await testApp.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pete@example.org' }),
    });

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/api/v1/auth');

    const body: Record<string, unknown> = await response.json();
    expect(Object.keys(body)).toEqual(['accessToken', 'expiresAt', 'user']);
  });

  it('stores only a hash of the refresh token', async () => {
    const testApp = buildTestApp();
    const { refreshCookie } = await devLogin(testApp, { email: 'pete@example.org' });

    const [stored] = await db.select().from(refreshTokens);

    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.tokenHash).not.toBe(refreshCookie);
  });

  it('rotates the refresh token on use', async () => {
    const testApp = buildTestApp();
    const { refreshCookie } = await devLogin(testApp, { email: 'pete@example.org' });

    const response = await testApp.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });

    expect(response.status).toBe(200);

    const rows = await db.select().from(refreshTokens);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revokedReason === 'rotated')).toHaveLength(1);
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
    // Both belong to the same family, so a later replay can revoke all of it.
    expect(new Set(rows.map((row) => row.familyId)).size).toBe(1);
  });

  it('revokes the whole refresh family when a rotated refresh token is replayed', async () => {
    const testApp = buildTestApp();
    const { refreshCookie } = await devLogin(testApp, { email: 'pete@example.org' });

    // Legitimate rotation.
    const rotated = await testApp.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });
    expect(rotated.status).toBe(200);

    // The attacker replays the token they stole before rotation.
    const replay = await testApp.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });
    expect(replay.status).toBe(401);

    // Every token in the family is now dead, including the legitimate one the
    // real user is holding. That is the intended trade-off.
    const rows = await db.select().from(refreshTokens);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect(rows.some((row) => row.revokedReason === 'replay_detected')).toBe(true);
  });

  it('refuses a refresh token that was never issued', async () => {
    const testApp = buildTestApp();
    await devLogin(testApp, { email: 'pete@example.org' });

    const response = await testApp.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader('not-a-real-token'),
    });

    expect(response.status).toBe(401);
  });

  it('refuses a refresh for a deactivated user and kills the family', async () => {
    const testApp = buildTestApp();
    const { refreshCookie, userId } = await devLogin(testApp, { email: 'pete@example.org' });

    await db.update(users).set({ isActive: 0 }).where(eq(users.id, userId));

    const response = await testApp.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });

    expect(response.status).toBe(401);
    const rows = await db.select().from(refreshTokens);
    expect(rows.every((row) => row.revokedReason === 'user_deactivated')).toBe(true);
  });

  it('logging out revokes the family, not just the presented token', async () => {
    const testApp = buildTestApp();
    const { refreshCookie } = await devLogin(testApp, { email: 'pete@example.org' });

    const response = await testApp.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });
    expect(response.status).toBe(204);

    const retry = await testApp.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });
    expect(retry.status).toBe(401);
  });

  it('records the login timestamp', async () => {
    const testApp = buildTestApp();
    const { userId } = await devLogin(testApp, { email: 'pete@example.org' });

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user?.lastLoginAt).toEqual(expect.any(String));
  });
});

describe('route protection', () => {
  beforeEach(async () => {
    await db.delete(refreshTokens);
    await db.delete(users);
  });

  it('rejects a request with no authorization header', async () => {
    const testApp = buildTestApp();

    const response = await testApp.request('/api/v1/auth/me');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('rejects a malformed authorization header', async () => {
    const testApp = buildTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'pete@example.org' });

    for (const header of [accessToken, `Basic ${accessToken}`, 'Bearer ']) {
      const response = await testApp.request('/api/v1/auth/me', {
        headers: { authorization: header },
      });
      expect(response.status).toBe(401);
    }
  });

  it('carries the team lead role into the access token', async () => {
    const testApp = buildTestApp();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@example.org',
      role: 'team_lead',
    });

    const me = await testApp.request('/api/v1/auth/me', { headers: authHeaders(accessToken) });

    expect(await me.json()).toMatchObject({ role: 'team_lead' });
  });
});
