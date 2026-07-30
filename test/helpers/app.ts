import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config/env.ts';
import type { Clock } from '../../src/core/clock.ts';
import { createDatabase } from '../../src/db/client.ts';
import { users, type UserRole } from '../../src/db/schema/users.ts';
import type { AppEnv, Bindings } from '../../src/http/types.ts';

export interface TestAppOptions {
  /** Overrides merged into the Worker bindings, e.g. `{ AUTH_MODE: 'google' }`. */
  readonly bindings?: Record<string, unknown>;
  readonly clock?: Clock;
  /**
   * The client IP rate limiting keys on. Each app gets its own by default so
   * one test's requests cannot exhaust another's budget; pass a fixed value to
   * deliberately share a bucket.
   */
  readonly clientIp?: string;
}

export interface TestApp {
  readonly app: Hono<AppEnv>;
  readonly env: Bindings;
  /** Issues a request against this app with the right bindings already attached. */
  request(path: string, init?: RequestInit): Promise<Response>;
}

/**
 * Builds an app the way `worker.ts` does — config first, then routes — so
 * build-time route decisions (such as omitting dev-login) are exercised
 * rather than bypassed.
 */
export function buildTestApp(options: TestAppOptions = {}): TestApp {
  const bindings = { ...env, ...options.bindings } as unknown as Bindings;
  const app = buildApp(
    loadConfig(bindings),
    options.clock === undefined ? {} : { clock: options.clock },
  );

  const clientIp = options.clientIp ?? `test-${crypto.randomUUID()}`;

  return {
    app,
    env: bindings,
    request: async (path, init) =>
      app.request(
        path,
        {
          ...init,
          // Rate limiting keys on this. Injected unless the caller set it, so
          // tests do not share a bucket by accident.
          headers: { 'cf-connecting-ip': clientIp, ...toHeaderRecord(init?.headers) },
        },
        bindings,
      ),
  };
}

/** Normalises whatever shape of headers a caller passed into a plain record. */
function toHeaderRecord(headers: RequestInit['headers']): Record<string, string> {
  if (headers === undefined) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

/**
 * Ensures a user exists, and returns their id.
 *
 * Accounts are created by an admin, never by logging in, so a test that wants
 * to be somebody has to say who that is first. Written straight to the
 * database rather than through `POST /users`: it is fixture setup, and going
 * through the API would need an admin token, which needs a user.
 */
export async function seedUser(user: {
  email: string;
  role?: UserRole;
  displayName?: string;
  isActive?: 0 | 1;
}): Promise<string> {
  const db = createDatabase(env.DB);
  const email = user.email.trim().toLowerCase();

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing !== undefined) return existing.id;

  const now = new Date().toISOString();
  const [inserted] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email,
      displayName: user.displayName ?? email,
      role: user.role ?? 'admin',
      googleSubject: null,
      isActive: user.isActive ?? 1,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (inserted === undefined) throw new Error(`Failed to seed user`);
  return inserted.id;
}

/**
 * Seeds the account if it is not there yet, then logs in through the dummy
 * provider and returns the tokens plus the cookie.
 */
export async function devLogin(
  testApp: TestApp,
  body: { email: string; displayName?: string; role?: UserRole },
): Promise<{ accessToken: string; refreshCookie: string; userId: string }> {
  await seedUser(body);

  const response = await testApp.request('/api/v1/auth/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: body.email }),
  });

  if (response.status !== 200) {
    throw new Error(`dev-login failed with ${String(response.status)}: ${await response.text()}`);
  }

  const payload: { accessToken: string; user: { id: string } } = await response.json();
  return {
    accessToken: payload.accessToken,
    refreshCookie: extractRefreshCookie(response),
    userId: payload.user.id,
  };
}

export function extractRefreshCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) {
    throw new Error('No set-cookie header on the response');
  }
  const value = /foodbank_refresh=([^;]+)/.exec(header)?.[1];
  if (value === undefined) {
    throw new Error(`No refresh cookie in: ${header}`);
  }
  return value;
}

export function authHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

export function cookieHeader(refreshCookie: string): Record<string, string> {
  return { cookie: `foodbank_refresh=${refreshCookie}` };
}
