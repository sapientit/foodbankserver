import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { voucherConfig } from '../src/db/schema/voucher-config.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';

/**
 * `GET/PUT /api/v1/voucher-config` — the Christmas-voucher date range an
 * administrator maintains, `INITIAL_SPEC1.txt`, `#Christmas voucher and
 * first-time selection`. Saved whole (`voucher-config.repository.ts#save`,
 * the same singleton upsert `parcel-grid` uses), admin-only both ways.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

async function adminWorld(): Promise<{ testApp: TestApp; token: string }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  return { testApp, token: accessToken };
}

beforeEach(async () => {
  await db.delete(voucherConfig);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('GET /voucher-config', () => {
  it('returns both dates null before anything has been saved', async () => {
    const { testApp, token } = await adminWorld();

    const response = await testApp.request('/api/v1/voucher-config', {
      headers: authHeaders(token),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ startDate: null, endDate: null });
  });

  it('refuses a team lead', async () => {
    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, { email: 'lead@foodbank.org', role: 'team_lead' });

    const response = await lead.request('/api/v1/voucher-config', {
      headers: authHeaders(accessToken),
    });

    expect(response.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const testApp = buildTestApp({ clock: fixedClock(NOW) });

    const response = await testApp.request('/api/v1/voucher-config');

    expect(response.status).toBe(401);
  });
});

describe('PUT /voucher-config', () => {
  it('round-trips the saved range through a subsequent GET', async () => {
    const { testApp, token } = await adminWorld();

    const put = await testApp.request('/api/v1/voucher-config', {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ startDate: '2026-12-01', endDate: '2026-12-24' }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ startDate: '2026-12-01', endDate: '2026-12-24' });

    const get = await testApp.request('/api/v1/voucher-config', {
      headers: authHeaders(token),
    });
    expect(await get.json()).toEqual({ startDate: '2026-12-01', endDate: '2026-12-24' });
  });

  it('rejects an endDate before startDate and leaves any existing value unchanged', async () => {
    const { testApp, token } = await adminWorld();

    // A valid range first, so there is something to prove the refused PUT did
    // not touch.
    await testApp.request('/api/v1/voucher-config', {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ startDate: '2026-12-01', endDate: '2026-12-24' }),
    });

    const invalid = await testApp.request('/api/v1/voucher-config', {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ startDate: '2026-12-24', endDate: '2026-12-01' }),
    });
    expect(invalid.status).toBe(400);

    const get = await testApp.request('/api/v1/voucher-config', {
      headers: authHeaders(token),
    });
    expect(await get.json()).toEqual({ startDate: '2026-12-01', endDate: '2026-12-24' });
  });

  it('rejects an endDate before startDate when nothing has been saved yet', async () => {
    const { testApp, token } = await adminWorld();

    const invalid = await testApp.request('/api/v1/voucher-config', {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ startDate: '2026-12-24', endDate: '2026-12-01' }),
    });
    expect(invalid.status).toBe(400);

    const get = await testApp.request('/api/v1/voucher-config', {
      headers: authHeaders(token),
    });
    expect(await get.json()).toEqual({ startDate: null, endDate: null });
  });

  it('replaces both fields together on a second save', async () => {
    const { testApp, token } = await adminWorld();

    await testApp.request('/api/v1/voucher-config', {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ startDate: '2026-12-01', endDate: '2026-12-24' }),
    });

    const second = await testApp.request('/api/v1/voucher-config', {
      method: 'PUT',
      headers: json(token),
      body: JSON.stringify({ startDate: '2026-11-15', endDate: '2026-11-30' }),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ startDate: '2026-11-15', endDate: '2026-11-30' });

    const get = await testApp.request('/api/v1/voucher-config', {
      headers: authHeaders(token),
    });
    expect(await get.json()).toEqual({ startDate: '2026-11-15', endDate: '2026-11-30' });
  });

  it('refuses a team lead', async () => {
    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, { email: 'lead@foodbank.org', role: 'team_lead' });

    const response = await lead.request('/api/v1/voucher-config', {
      method: 'PUT',
      headers: json(accessToken),
      body: JSON.stringify({ startDate: '2026-12-01', endDate: '2026-12-24' }),
    });

    expect(response.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const testApp = buildTestApp({ clock: fixedClock(NOW) });

    const response = await testApp.request('/api/v1/voucher-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: '2026-12-01', endDate: '2026-12-24' }),
    });

    expect(response.status).toBe(401);
  });
});
