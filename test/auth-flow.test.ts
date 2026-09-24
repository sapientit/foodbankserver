import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import {
  authHeaders,
  buildTestApp,
  cookieHeader,
  devLogin,
  extractRefreshCookie,
  googleLogin,
  seedUser,
} from './helpers/app.ts';
import {
  GOOGLE_TEST_CLIENT_ID,
  defaultGoogleClaims,
  generateGoogleTestKeyPair,
  googleJwksBody,
  jsonResponse,
  signGoogleIdToken,
  type GoogleTestKeyPair,
} from './helpers/google-token.ts';

const db = createDatabase(env.DB);

/**
 * Fake timers do not work in the Workers pool, so an eight-hour sign-in is
 * tested by driving the same database through apps built on different clocks.
 */
const SIGNED_IN_AT = '2026-08-04T09:00:00.000Z';
const appAt = (instant: string) => buildTestApp({ clock: fixedClock(instant) });

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

  it('refuses a missing email with 400, not 500', async () => {
    // Regression: the dummy provider used to call `devLoginSchema.parse`
    // directly, throwing a raw ZodError that fell through error-handler.ts's
    // `isAppError` check to an opaque 500 — the same bug caught in
    // google-provider.ts below. `parseOrThrow` is what maps it to 400.
    const testApp = buildTestApp();

    const response = await testApp.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it('does not register the dev-login route when AUTH_MODE is google', async () => {
    const testApp = buildTestApp({
      bindings: { AUTH_MODE: 'google', GOOGLE_AUTH_CLIENT_ID: GOOGLE_TEST_CLIENT_ID },
    });

    const response = await testApp.request('/api/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pete@example.org' }),
    });

    expect(response.status).toBe(404);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('does not register the google-login route when AUTH_MODE is dummy', async () => {
    const testApp = buildTestApp(); // AUTH_MODE defaults to dummy

    const response = await testApp.request('/api/v1/auth/google-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: 'whatever' }),
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
    expect(new Set(rows.map((row) => row.familyId)).size).toBe(1);
  });

  it('refuses a refresh token that has already been rotated', async () => {
    const testApp = buildTestApp();
    const { refreshCookie } = await devLogin(testApp, { email: 'pete@example.org' });

    const rotated = await testApp.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });
    expect(rotated.status).toBe(200);

    const replay = await testApp.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });

    expect(replay.status).toBe(401);
  });

  it('leaves the legitimate holder signed in after somebody replays an old token', async () => {
    const testApp = buildTestApp();
    const { refreshCookie } = await devLogin(testApp, { email: 'pete@example.org' });

    const rotated = await testApp.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });
    const heldByTheUser = extractRefreshCookie(rotated);

    // Somebody replays the token that was rotated away.
    await testApp.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });

    // The person actually signed in is unaffected — no family-wide revocation.
    const carryOn = await testApp.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(heldByTheUser),
    });
    expect(carryOn.status).toBe(200);

    const rows = await db.select().from(refreshTokens);
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
    expect(rows.some((row) => row.revokedReason === 'replay_detected')).toBe(false);
  });

  it('keeps someone signed in seven hours after they signed in', async () => {
    const { refreshCookie } = await devLogin(appAt(SIGNED_IN_AT), { email: 'pete@example.org' });

    const response = await appAt('2026-08-04T16:00:00.000Z').request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });

    expect(response.status).toBe(200);
  });

  it('refuses a refresh once eight hours have passed since signing in', async () => {
    const { refreshCookie } = await devLogin(appAt(SIGNED_IN_AT), { email: 'pete@example.org' });

    const response = await appAt('2026-08-04T17:00:01.000Z').request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });

    expect(response.status).toBe(401);
  });

  it('does not extend the eight hours by refreshing part-way through them', async () => {
    const { refreshCookie } = await devLogin(appAt(SIGNED_IN_AT), { email: 'pete@example.org' });

    // Working through the morning, so the token rotates several times.
    let cookie = refreshCookie;
    for (const at of ['2026-08-04T12:00:00.000Z', '2026-08-04T15:00:00.000Z']) {
      const rotated = await appAt(at).request('/api/v1/auth/refresh', {
        method: 'POST',
        headers: cookieHeader(cookie),
      });
      expect(rotated.status).toBe(200);
      cookie = extractRefreshCookie(rotated);
    }

    // Eight hours after signing in, not after the last refresh.
    const response = await appAt('2026-08-04T17:00:01.000Z').request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(cookie),
    });

    expect(response.status).toBe(401);
  });

  it('never issues an access token that outlives the sign-in', async () => {
    const { refreshCookie } = await devLogin(appAt(SIGNED_IN_AT), { email: 'pete@example.org' });

    // Five minutes from the cap, so a full fifteen-minute token would overrun.
    const response = await appAt('2026-08-04T16:55:00.000Z').request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: cookieHeader(refreshCookie),
    });

    const body: { expiresAt: number } = await response.json();
    expect(body.expiresAt).toBe(Date.parse('2026-08-04T17:00:00.000Z') / 1000);
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

describe('Google sign-in', () => {
  const GOOGLE_SIGNED_IN_AT = '2026-08-04T09:00:00.000Z';
  const googleClock = fixedClock(GOOGLE_SIGNED_IN_AT);

  /** An app with a working Google sign-in configured, on a fixed clock so token `exp` is stable. */
  function googleApp() {
    return buildTestApp({
      clock: googleClock,
      bindings: { AUTH_MODE: 'google', GOOGLE_AUTH_CLIENT_ID: GOOGLE_TEST_CLIENT_ID },
    });
  }

  let keyPair: GoogleTestKeyPair;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    keyPair = await generateGoogleTestKeyPair();
  });

  beforeEach(async () => {
    await db.delete(refreshTokens);
    await db.delete(users);

    // A fresh `Response` per call, not `mockResolvedValue` with one shared
    // instance: a `Response` body can only be read once, and this mock is
    // called twice within a single test that signs in the same person twice.
    fetchMock = vi.fn(() => Promise.resolve(jsonResponse(googleJwksBody(keyPair))));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('signs in an existing user resolved by email and backfills their Google subject', async () => {
    const testApp = googleApp();
    const userId = await seedUser({ email: 'pete@guildfordfoodbank.org', role: 'team_lead' });
    const token = await signGoogleIdToken(
      keyPair.privateKey,
      defaultGoogleClaims(googleClock.nowEpochSeconds()),
    );

    const before = await db.select().from(users).where(eq(users.id, userId));
    expect(before[0]?.googleSubject).toBeNull();

    const { accessToken, refreshCookie } = await googleLogin(testApp, token);

    expect(refreshCookie).toEqual(expect.any(String));
    const me = await testApp.request('/api/v1/auth/me', { headers: authHeaders(accessToken) });
    expect(await me.json()).toEqual({
      id: userId,
      email: 'pete@guildfordfoodbank.org',
      role: 'team_lead',
    });

    const [after] = await db.select().from(users).where(eq(users.id, userId));
    expect(after?.googleSubject).toBe('google-subject-1');
  });

  it('resolves a second Google login by the linked subject rather than by email again', async () => {
    const testApp = googleApp();
    const userId = await seedUser({ email: 'pete@guildfordfoodbank.org', role: 'team_lead' });
    const token = await signGoogleIdToken(
      keyPair.privateKey,
      defaultGoogleClaims(googleClock.nowEpochSeconds()),
    );

    const first = await googleLogin(testApp, token);
    expect(first.userId).toBe(userId);

    // Second sign-in: the subject is now linked, so this resolves through
    // `findUserByGoogleSubject` rather than falling back to the email lookup.
    const second = await googleLogin(testApp, token);
    expect(second.userId).toBe(userId);

    expect(await db.select().from(users)).toHaveLength(1);
  });

  it('refuses a Google login for an email address with no user record', async () => {
    const testApp = googleApp();
    const token = await signGoogleIdToken(keyPair.privateKey, {
      ...defaultGoogleClaims(googleClock.nowEpochSeconds()),
      email: 'stranger@guildfordfoodbank.org',
    });

    const response = await testApp.request('/api/v1/auth/google-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });

    expect(response.status).toBe(401);
    // Same answer as any other failed login: whether an address is registered
    // here is not something an unauthenticated caller should learn.
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('refuses a Google login for a deactivated user', async () => {
    const testApp = googleApp();
    await seedUser({ email: 'gone@guildfordfoodbank.org', isActive: 0 });
    const token = await signGoogleIdToken(keyPair.privateKey, {
      ...defaultGoogleClaims(googleClock.nowEpochSeconds()),
      email: 'gone@guildfordfoodbank.org',
    });

    const response = await testApp.request('/api/v1/auth/google-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });

    expect(response.status).toBe(403);
    expect(await db.select().from(refreshTokens)).toHaveLength(0);
  });

  it('refuses a missing idToken with 400, not 500', async () => {
    // Regression: google-provider.ts used to call `googleLoginSchema.parse`
    // directly, throwing a raw ZodError that fell through error-handler.ts's
    // `isAppError` check to an opaque 500 instead of the 400 openapi.yaml
    // documents. Found by hand against the deployed test system, not by a
    // test — nothing here exercised a body missing the field entirely.
    // `parseOrThrow` is what maps it to 400; fetch must never be reached.
    const testApp = googleApp();

    const response = await testApp.request('/api/v1/auth/google-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
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
