import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { formDefinitions, formFields } from '../src/db/schema/forms.ts';
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

async function createDraftWithField(
  testApp: TestApp,
  token: string,
  title: string,
  key = 'dietary_needs',
): Promise<string> {
  const draft = await testApp.request('/api/v1/form-definitions', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ title }),
  });
  expect(draft.status).toBe(201);
  const { id }: { id: string } = await draft.json();

  const field = await testApp.request(`/api/v1/form-definitions/${id}/fields`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ key, label: 'Dietary needs', type: 'text' }),
  });
  expect(field.status).toBe(201);

  return id;
}

beforeEach(async () => {
  await db.delete(formFields);
  await db.delete(formDefinitions);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('form versioning', () => {
  it('numbers versions sequentially without reuse', async () => {
    const { testApp, token } = await adminApp();

    await createDraftWithField(testApp, token, 'v1');
    await createDraftWithField(testApp, token, 'v2', 'other_key');

    const list = await testApp.request('/api/v1/form-definitions', { headers: authHeaders(token) });
    const body: { formDefinitions: { version: number }[] } = await list.json();

    expect(body.formDefinitions.map((d) => d.version).sort()).toEqual([1, 2]);
  });

  it('publishing retires the previous version', async () => {
    const { testApp, token } = await adminApp();
    const first = await createDraftWithField(testApp, token, 'v1');
    const second = await createDraftWithField(testApp, token, 'v2', 'other_key');

    await testApp.request(`/api/v1/form-definitions/${first}/publish`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    const publishSecond = await testApp.request(`/api/v1/form-definitions/${second}/publish`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(publishSecond.status).toBe(200);

    const rows = await db.select().from(formDefinitions);
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(first)?.status).toBe('retired');
    expect(byId.get(first)?.retiredAt).toEqual(expect.any(String));
    expect(byId.get(second)?.status).toBe('published');
    // The partial unique index guarantees this; assert it holds in practice.
    expect(rows.filter((row) => row.status === 'published')).toHaveLength(1);
  });

  it('refuses to publish a form with no questions', async () => {
    const { testApp, token } = await adminApp();
    const draft = await testApp.request('/api/v1/form-definitions', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ title: 'Empty' }),
    });
    const { id }: { id: string } = await draft.json();

    const response = await testApp.request(`/api/v1/form-definitions/${id}/publish`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(409);
  });

  it('a published form cannot be edited', async () => {
    const { testApp, token } = await adminApp();
    const id = await createDraftWithField(testApp, token, 'v1');
    await testApp.request(`/api/v1/form-definitions/${id}/publish`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const addField = await testApp.request(`/api/v1/form-definitions/${id}/fields`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ key: 'sneaky', label: 'Sneaky', type: 'text' }),
    });

    expect(addField.status).toBe(409);
    expect(await addField.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('a field on a published form cannot be changed or deleted', async () => {
    const { testApp, token } = await adminApp();
    const id = await createDraftWithField(testApp, token, 'v1');
    const [existing] = await db.select().from(formFields);
    await testApp.request(`/api/v1/form-definitions/${id}/publish`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const patch = await testApp.request(`/api/v1/form-fields/${existing?.id ?? ''}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ label: 'Renamed' }),
    });
    const remove = await testApp.request(`/api/v1/form-fields/${existing?.id ?? ''}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });

    expect(patch.status).toBe(409);
    expect(remove.status).toBe(409);
  });

  it('reads a referral captured under form version 1 after version 2 is published', async () => {
    const { testApp, token } = await adminApp();
    const v1 = await createDraftWithField(testApp, token, 'v1', 'dietary_needs');
    await testApp.request(`/api/v1/form-definitions/${v1}/publish`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const v2 = await createDraftWithField(testApp, token, 'v2', 'transport_needs');
    await testApp.request(`/api/v1/form-definitions/${v2}/publish`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    // Version 1 is retired but fully intact, so an answer captured under it is
    // still interpretable. This is what makes the JSON-answers design safe.
    const response = await testApp.request(`/api/v1/form-definitions/${v1}`, {
      headers: authHeaders(token),
    });
    const body: { status: string; version: number; fields: { key: string }[] } =
      await response.json();

    expect(body.status).toBe('retired');
    expect(body.version).toBe(1);
    expect(body.fields.map((f) => f.key)).toEqual(['dietary_needs']);
  });

  it('rejects a duplicate field key within a version', async () => {
    const { testApp, token } = await adminApp();
    const id = await createDraftWithField(testApp, token, 'v1', 'dietary_needs');

    const duplicate = await testApp.request(`/api/v1/form-definitions/${id}/fields`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ key: 'dietary_needs', label: 'Again', type: 'text' }),
    });

    expect(duplicate.status).toBe(409);
    const body = await duplicate.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'CONFLICT' } });
    // The SQLite message must not reach the client.
    expect(body).not.toContain('UNIQUE');
  });

  it('requires options on a select field', async () => {
    const { testApp, token } = await adminApp();
    const draft = await testApp.request('/api/v1/form-definitions', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ title: 'v1' }),
    });
    const { id }: { id: string } = await draft.json();

    const response = await testApp.request(`/api/v1/form-definitions/${id}/fields`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ key: 'transport', label: 'Transport', type: 'select' }),
    });

    expect(response.status).toBe(400);
  });
});

describe('public referral form', () => {
  it('serves the published version with active reasons, unauthenticated', async () => {
    const { testApp, token } = await adminApp();
    const id = await createDraftWithField(testApp, token, 'v1');
    await testApp.request(`/api/v1/form-definitions/${id}/publish`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    for (const [code, label, active] of [
      ['benefit_delay', 'Benefit delay', true],
      ['retired_reason', 'No longer offered', false],
    ] as const) {
      const created = await testApp.request('/api/v1/referral-reasons', {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ code, label }),
      });
      const reason: { id: string } = await created.json();
      if (!active) {
        await testApp.request(`/api/v1/referral-reasons/${reason.id}`, {
          method: 'PATCH',
          headers: json(token),
          body: JSON.stringify({ isActive: false }),
        });
      }
    }

    const response = await testApp.request('/api/v1/public/referral-form');
    const body: {
      version: number;
      reasons: { code: string }[];
      fields: Record<string, unknown>[];
    } = await response.json();

    expect(response.status).toBe(200);
    expect(body.version).toBe(1);
    // Retired reasons are not offered for new referrals.
    expect(body.reasons.map((r) => r.code)).toEqual(['benefit_delay']);
    // isPii is an internal classification and must not be published.
    expect(Object.keys(body.fields[0] ?? {})).not.toContain('isPii');
  });

  it('reports 404 when nothing has been published yet', async () => {
    const testApp = buildTestApp();

    const response = await testApp.request('/api/v1/public/referral-form');

    expect(response.status).toBe(404);
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

describe('referral admin authorisation', () => {
  it('refuses a team lead managing referrers, reasons or forms', async () => {
    const testApp = buildTestApp();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    for (const path of [
      '/api/v1/authorised-referrers',
      '/api/v1/referral-reasons',
      '/api/v1/form-definitions',
    ]) {
      const response = await testApp.request(path, { headers: authHeaders(accessToken) });
      expect(response.status).toBe(403);
    }
  });

  it('requires authentication', async () => {
    const testApp = buildTestApp();

    expect((await testApp.request('/api/v1/form-definitions')).status).toBe(401);
  });
});
