import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOLUNTEER_CODE_TTL_SECONDS } from '../src/config/constants.ts';
import { fixedClock } from '../src/core/clock.ts';
import { normaliseVolunteerCode, sha256Hex } from '../src/core/crypto/tokens.ts';
import { createDatabase } from '../src/db/client.ts';
import { crateMembers, crates } from '../src/db/schema/crates.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { volunteerCodes } from '../src/db/schema/volunteer-codes.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';

const db = createDatabase(env.DB);

// September is BST: a London wall clock an hour ahead of UTC, which is the
// case that catches a timezone bug in the expiry maths.
const ISSUE_INSTANT = '2026-09-08T09:00:00Z';
const issueEpochSeconds = Math.floor(Date.parse(ISSUE_INSTANT) / 1000);

function json(headers: Record<string, string>): Record<string, string> {
  return { ...headers, 'content-type': 'application/json' };
}

function codeHeader(code: string): Record<string, string> {
  return { 'x-volunteer-code': code };
}

/** An app pinned to the moment the code is issued. */
function issuerApp(): TestApp {
  return buildTestApp({ clock: fixedClock(ISSUE_INSTANT) });
}

/** An app pinned to `issue + offsetSeconds`, for expiry and sweep. */
function laterApp(offsetSeconds: number): TestApp {
  return buildTestApp({
    clock: fixedClock(new Date((issueEpochSeconds + offsetSeconds) * 1000).toISOString()),
  });
}

async function adminApp(): Promise<{ testApp: TestApp; token: string; userId: string }> {
  const testApp = issuerApp();
  const { accessToken, userId } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  return { testApp, token: accessToken, userId };
}

async function teamLeadApp(): Promise<{ testApp: TestApp; token: string; userId: string }> {
  const testApp = issuerApp();
  const { accessToken, userId } = await devLogin(testApp, {
    email: 'lead@foodbank.org',
    role: 'team_lead',
  });
  return { testApp, token: accessToken, userId };
}

async function createItem(testApp: TestApp, token: string, name: string, shelfNumber: string) {
  const response = await testApp.request('/api/v1/stock/items', {
    method: 'POST',
    headers: json(authHeaders(token)),
    body: JSON.stringify({ name, category: 'Tinned Goods', shelfNumber }),
  });
  expect(response.status).toBe(201);
  const { id }: { id: string } = await response.json();
  return id;
}

async function generateCode(
  testApp: TestApp,
  token: string,
): Promise<{ code: string; expiresAt: number; status: number }> {
  const response = await testApp.request('/api/v1/stock/take/volunteer-codes', {
    method: 'POST',
    headers: authHeaders(token),
  });
  const status = response.status;
  if (status !== 201) return { code: '', expiresAt: 0, status };
  const body: { code: string; expiresAt: number } = await response.json();
  return { ...body, status };
}

beforeEach(async () => {
  await db.delete(crateMembers);
  await db.delete(crates);
  await db.delete(stockLedger);
  await db.delete(stockItems);
  await db.delete(volunteerCodes);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('minting a volunteer code', () => {
  it('lets an admin mint a code shaped XXXX-XXXX-XXXX-XXXX that expires 8h after issue', async () => {
    const { testApp, token } = await adminApp();

    const { code, expiresAt, status } = await generateCode(testApp, token);

    expect(status).toBe(201);
    // Crockford base32 in four groups of four — no I, L, O or U.
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(expiresAt).toBe(issueEpochSeconds + VOLUNTEER_CODE_TTL_SECONDS);
    expect(VOLUNTEER_CODE_TTL_SECONDS).toBe(8 * 60 * 60);
  });

  it('lets a team lead mint a code', async () => {
    const { testApp, token } = await teamLeadApp();
    const { status } = await generateCode(testApp, token);
    expect(status).toBe(201);
  });

  it('refuses to mint a code for a signed-out caller', async () => {
    const testApp = issuerApp();
    const response = await testApp.request('/api/v1/stock/take/volunteer-codes', {
      method: 'POST',
    });
    expect(response.status).toBe(401);
  });

  it('refuses to let a volunteer code mint another volunteer code', async () => {
    const { testApp, token } = await teamLeadApp();
    const { code } = await generateCode(testApp, token);

    const response = await issuerApp().request('/api/v1/stock/take/volunteer-codes', {
      method: 'POST',
      headers: codeHeader(code),
    });
    expect(response.status).toBe(401);
  });
});

describe('a valid code authenticates exactly the four grouped stock-take routes', () => {
  it('reads /stock/levels, /stock/groupings and /stock/crates with the same payload as a team lead', async () => {
    const { testApp: admin, token: adminToken } = await adminApp();
    await createItem(admin, adminToken, 'Beans', 'A2');

    const { testApp: lead, token: leadToken } = await teamLeadApp();
    const { code } = await generateCode(lead, leadToken);
    const volunteer = issuerApp();

    for (const path of ['/stock/levels', '/stock/groupings', '/stock/crates']) {
      const asLead = await lead.request(`/api/v1${path}`, { headers: authHeaders(leadToken) });
      const asVolunteer = await volunteer.request(`/api/v1${path}`, { headers: codeHeader(code) });

      expect(asVolunteer.status, path).toBe(200);
      expect(asLead.status, path).toBe(200);
      expect(await asVolunteer.json(), path).toEqual(await asLead.json());
    }
  });

  it('saves a counted page through POST /stock/take', async () => {
    const { testApp: admin, token: adminToken } = await adminApp();
    const beans = await createItem(admin, adminToken, 'Beans', 'A2');

    const { testApp: lead, token: leadToken } = await teamLeadApp();
    const { code } = await generateCode(lead, leadToken);

    const response = await issuerApp().request('/api/v1/stock/take', {
      method: 'POST',
      headers: json(codeHeader(code)),
      body: JSON.stringify({ counts: [{ stockItemId: beans, countedQuantity: 12 }] }),
    });

    expect(response.status).toBe(200);
    const body: { applied: number; levels: { stockItemId: string; quantityOnHand: number }[] } =
      await response.json();
    expect(body.applied).toBe(1);
    expect(body.levels).toEqual([{ stockItemId: beans, quantityOnHand: 12 }]);
  });

  it('accepts the code case-insensitively and with separators optional', async () => {
    const { testApp: lead, token: leadToken } = await teamLeadApp();
    const { code } = await generateCode(lead, leadToken);

    const grouped = code.toUpperCase();
    const bare = code.replaceAll('-', '').toLowerCase();

    for (const presented of [grouped, bare]) {
      const response = await issuerApp().request('/api/v1/stock/levels', {
        headers: codeHeader(presented),
      });
      expect(response.status, presented).toBe(200);
    }
  });

  it('authenticates a code whose confusable letters were written the wrong way', async () => {
    const { testApp: lead, token: leadToken } = await teamLeadApp();
    const { code } = await generateCode(lead, leadToken);

    // What a volunteer copying off a slip of paper might write: I for 1, O for
    // 0, U for V. A minted code contains none of I/L/O/U, so folding these back
    // must land on the same string that was hashed.
    const sloppy = code.replaceAll('1', 'I').replaceAll('0', 'O').replaceAll('V', 'U');

    const response = await issuerApp().request('/api/v1/stock/levels', {
      headers: codeHeader(sloppy),
    });
    expect(response.status).toBe(200);
  });
});

describe('normaliseVolunteerCode', () => {
  it('folds case, separators and the confusable letters, and is idempotent', () => {
    expect(normaliseVolunteerCode('kp7q-4xzm-9rtw-2njh')).toBe('KP7Q4XZM9RTW2NJH');
    expect(normaliseVolunteerCode('I l O u')).toBe('110V');
    expect(normaliseVolunteerCode('1-1-0-V')).toBe('110V');

    const once = normaliseVolunteerCode('iLoU-70p9');
    expect(normaliseVolunteerCode(once)).toBe(once);
  });
});

describe('a valid code is rejected everywhere else', () => {
  // Each of these routes simply lacks the `stockCountingAuth` middleware, so a
  // request that carries only `X-Volunteer-Code` and no bearer token is
  // unauthenticated and must 401 — never 200, never 403.
  it('401s on the stock routes that are signed-in only, and on a non-stock route', async () => {
    const { testApp: admin, token: adminToken } = await adminApp();
    const beans = await createItem(admin, adminToken, 'Beans', 'A2');

    const { testApp: lead, token: leadToken } = await teamLeadApp();
    const { code } = await generateCode(lead, leadToken);
    const app = issuerApp();

    const rejected: { method: string; path: string; body?: unknown }[] = [
      {
        method: 'POST',
        path: `/api/v1/stock/items/${beans}/corrections`,
        body: { quantityDelta: 1 },
      },
      { method: 'GET', path: '/api/v1/stock/items' },
      {
        method: 'POST',
        path: '/api/v1/stock/items',
        body: { name: 'Rice', category: 'Dry', shelfNumber: 'B1' },
      },
      { method: 'GET', path: '/api/v1/stock/validation' },
      { method: 'POST', path: '/api/v1/stock/take/volunteer-codes' },
      { method: 'GET', path: '/api/v1/users' },
    ];

    for (const { method, path, body } of rejected) {
      const response = await app.request(path, {
        method,
        headers: body === undefined ? codeHeader(code) : json(codeHeader(code)),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('an unknown or expired code', () => {
  it('rejects an unknown code with 401 and the same message an expired one gives', async () => {
    const response = await issuerApp().request('/api/v1/stock/levels', {
      headers: codeHeader('ZZZZ-ZZZZ-ZZZZ-ZZZZ'),
    });
    expect(response.status).toBe(401);
    const body: { error: { message: string } } = await response.json();
    expect(body.error.message).toBe('Invalid volunteer code');
  });

  it('rejects a code presented exactly at its expiry instant', async () => {
    const { testApp: lead, token: leadToken } = await teamLeadApp();
    const { code } = await generateCode(lead, leadToken);

    // One second before expiry: still good.
    const justBefore = await laterApp(VOLUNTEER_CODE_TTL_SECONDS - 1).request(
      '/api/v1/stock/levels',
      { headers: codeHeader(code) },
    );
    expect(justBefore.status).toBe(200);

    // At the expiry instant: refused, with the no-oracle message.
    const atExpiry = await laterApp(VOLUNTEER_CODE_TTL_SECONDS).request('/api/v1/stock/levels', {
      headers: codeHeader(code),
    });
    expect(atExpiry.status).toBe(401);
    const body: { error: { message: string } } = await atExpiry.json();
    expect(body.error.message).toBe('Invalid volunteer code');
  });

  it('holds the 8h window across the October BST->GMT changeover', async () => {
    // Issue at 22:30 UTC on changeover day; the clocks go back at 01:00 UTC, so
    // the London wall clock is BST at issue and GMT at expiry. The window is
    // still exactly 8h of real time.
    const issue = '2026-10-25T22:30:00Z';
    const issueSecs = Math.floor(Date.parse(issue) / 1000);
    const issuer = buildTestApp({ clock: fixedClock(issue) });
    const { accessToken } = await devLogin(issuer, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });
    const gen = await issuer.request('/api/v1/stock/take/volunteer-codes', {
      method: 'POST',
      headers: authHeaders(accessToken),
    });
    const { code, expiresAt }: { code: string; expiresAt: number } = await gen.json();
    expect(expiresAt).toBe(issueSecs + VOLUNTEER_CODE_TTL_SECONDS);

    const at = (secs: number) =>
      buildTestApp({ clock: fixedClock(new Date(secs * 1000).toISOString()) }).request(
        '/api/v1/stock/levels',
        { headers: codeHeader(code) },
      );

    expect((await at(expiresAt - 1)).status).toBe(200);
    expect((await at(expiresAt)).status).toBe(401);
  });
});

describe('attribution and the sweep', () => {
  it('records a stock take on a code against the team lead who generated it', async () => {
    const { testApp: admin, token: adminToken } = await adminApp();
    const beans = await createItem(admin, adminToken, 'Beans', 'A2');

    const { testApp: lead, token: leadToken, userId: leadId } = await teamLeadApp();
    const { code } = await generateCode(lead, leadToken);

    const response = await issuerApp().request('/api/v1/stock/take', {
      method: 'POST',
      headers: json(codeHeader(code)),
      body: JSON.stringify({ counts: [{ stockItemId: beans, countedQuantity: 5 }] }),
    });
    expect(response.status).toBe(200);

    const rows = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.movementType, 'opening_balance'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stockItemId).toBe(beans);
    expect(rows[0]?.actorUserId).toBe(leadId);
  });

  it('sweeps lapsed codes when the next code is minted, in the same batch', async () => {
    const { testApp: lead, token: leadToken } = await teamLeadApp();
    const { code: codeA } = await generateCode(lead, leadToken);

    // A second team-lead app, clocked past codeA's expiry, mints codeB.
    const laterLead = laterApp(VOLUNTEER_CODE_TTL_SECONDS + 1);
    const { accessToken: laterToken } = await devLogin(laterLead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });
    const { code: codeB, status } = await generateCode(laterLead, laterToken);
    expect(status).toBe(201);

    // codeA's row is gone: only codeB remains.
    const remaining = await db.select().from(volunteerCodes);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.codeHash).toBe(await sha256Hex(normaliseVolunteerCode(codeB)));

    // And codeA no longer authenticates anything.
    const response = await laterApp(VOLUNTEER_CODE_TTL_SECONDS + 1).request(
      '/api/v1/stock/levels',
      {
        headers: codeHeader(codeA),
      },
    );
    expect(response.status).toBe(401);
  });
});

describe('the plaintext code never reaches the logs', () => {
  it('logs an identifier, not the code, when a code is minted and then used', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
      );
    });

    try {
      const lead = buildTestApp({
        clock: fixedClock(ISSUE_INSTANT),
        bindings: { LOG_LEVEL: 'debug' },
      });
      const { accessToken } = await devLogin(lead, {
        email: 'lead@foodbank.org',
        role: 'team_lead',
      });

      const gen = await lead.request('/api/v1/stock/take/volunteer-codes', {
        method: 'POST',
        headers: authHeaders(accessToken),
      });
      const { code }: { code: string } = await gen.json();

      // Use it, so the authenticate path logs too.
      const used = buildTestApp({
        clock: fixedClock(ISSUE_INSTANT),
        bindings: { LOG_LEVEL: 'debug' },
      });
      await used.request('/api/v1/stock/levels', { headers: codeHeader(code) });

      expect(logged.length).toBeGreaterThan(0);
      const haystack = logged.join('\n');
      expect(haystack).not.toContain(code);
      expect(haystack).not.toContain(normaliseVolunteerCode(code));
      expect(haystack).not.toContain(code.replaceAll('-', '').toLowerCase());
    } finally {
      spy.mockRestore();
    }
  });
});
