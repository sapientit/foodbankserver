import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';

const db = createDatabase(env.DB);

async function adminApp(): Promise<{ testApp: TestApp; token: string }> {
  const testApp = buildTestApp();
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  return { testApp, token: accessToken };
}

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

beforeEach(async () => {
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('the public reason dropdown', () => {
  it('offers the active reasons, in display order, unauthenticated', async () => {
    const { testApp, token } = await adminApp();

    for (const [code, label, displayOrder] of [
      ['other', 'Other', 2],
      ['benefit_delay', 'Benefit delay', 1],
    ] as const) {
      const created = await testApp.request('/api/v1/referral-reasons', {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ code, label, displayOrder }),
      });
      expect(created.status).toBe(201);
    }

    const response = await testApp.request('/api/v1/public/referral-reasons');
    const body: { referralReasons: { code: string; isActive?: boolean }[] } = await response.json();

    expect(response.status).toBe(200);
    expect(body.referralReasons.map((reason) => reason.code)).toEqual(['benefit_delay', 'other']);
    // `isActive` is a maintenance concern and must not reach the public form.
    expect(Object.keys(body.referralReasons[0] ?? {})).not.toContain('isActive');
  });

  it('withholds a retired reason, so it cannot be chosen for a new referral', async () => {
    const { testApp, token } = await adminApp();
    const created = await testApp.request('/api/v1/referral-reasons', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ code: 'retired_reason', label: 'No longer offered' }),
    });
    const { id }: { id: string } = await created.json();

    await testApp.request(`/api/v1/referral-reasons/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ isActive: false }),
    });

    const response = await testApp.request('/api/v1/public/referral-reasons');
    const body: { referralReasons: unknown[] } = await response.json();

    expect(body.referralReasons).toEqual([]);
    // Still visible to an admin, because historical referrals point at it.
    const admin = await testApp.request('/api/v1/referral-reasons', {
      headers: authHeaders(token),
    });
    const adminBody: { referralReasons: unknown[] } = await admin.json();
    expect(adminBody.referralReasons).toHaveLength(1);
  });
});

describe('public referrer check', () => {
  it('confirms an authorised domain without authentication', async () => {
    const { testApp, token } = await adminApp();
    await testApp.request('/api/v1/authorised-referrers', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        matchType: 'domain',
        matchValue: '*@guildford.gov.uk',
        organisationName: 'Guildford Borough Council',
      }),
    });

    const response = await testApp.request('/api/v1/public/referrers/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'anyone@guildford.gov.uk' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorised: true,
      organisationName: 'Guildford Borough Council',
    });
  });

  it('refuses an unknown address without saying why', async () => {
    const testApp = buildTestApp();

    const response = await testApp.request('/api/v1/public/referrers/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'stranger@example.org' }),
    });

    expect(await response.json()).toEqual({ authorised: false, organisationName: null });
  });

  it('honours a deactivated individual inside an authorised domain, end to end', async () => {
    const { testApp, token } = await adminApp();

    await testApp.request('/api/v1/authorised-referrers', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        matchType: 'domain',
        matchValue: '*@guildford.gov.uk',
        organisationName: 'Guildford Borough Council',
      }),
    });
    const created = await testApp.request('/api/v1/authorised-referrers', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        matchType: 'email',
        matchValue: 'jane@guildford.gov.uk',
        organisationName: 'Guildford Housing Team',
      }),
    });
    const { id }: { id: string } = await created.json();

    await testApp.request(`/api/v1/authorised-referrers/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ isActive: false }),
    });

    const check = async (email: string) => {
      const response = await testApp.request('/api/v1/public/referrers/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body: { authorised: boolean } = await response.json();
      return body.authorised;
    };

    expect(await check('jane@guildford.gov.uk')).toBe(false);
    expect(await check('bob@guildford.gov.uk')).toBe(true);
  });
});

describe('referrer and reason admin authorisation', () => {
  it('refuses a team lead managing referrers or reasons', async () => {
    const testApp = buildTestApp();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    for (const path of ['/api/v1/authorised-referrers', '/api/v1/referral-reasons']) {
      const response = await testApp.request(path, { headers: authHeaders(accessToken) });
      expect(response.status).toBe(403);
    }
  });

  it('requires authentication', async () => {
    const testApp = buildTestApp();

    expect((await testApp.request('/api/v1/authorised-referrers')).status).toBe(401);
  });
});
