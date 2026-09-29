import { env } from 'cloudflare:workers';
import { eq, ne } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import {
  configurationReleasePublications,
  configurationReleases,
  type ConfigurationRelease,
  type NewConfigurationRelease,
} from '../src/db/schema/configuration-releases.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { isUniqueViolation } from '../src/db/unique-violation.ts';
import { MAX_BULK_FORM_IDS } from '../src/modules/configuration-releases/configuration-releases.schema.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import { BASELINE_FORM_ID } from './helpers/referral-fixtures.ts';

/**
 * `configuration-releases` — versioned referral forms and preference rules.
 * `INITIAL_SPEC1.txt`, `#referral`. Migration `0040`, `configuration-releases.*`.
 */

const db = createDatabase(env.DB);
const NOW = '2026-09-26T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

interface UploadBody {
  questionnaire: string;
  rules: string;
  questionnaireHash: string;
  rulesHash: string;
  generationId: string;
  generatedAt: string;
  sourceWorkbookId: string;
}

function uploadBody(overrides: Partial<UploadBody> = {}): UploadBody {
  return {
    questionnaire: JSON.stringify({ version: 1, pages: [] }),
    rules: JSON.stringify({ rules: [] }),
    questionnaireHash: `q-${crypto.randomUUID()}`,
    rulesHash: `r-${crypto.randomUUID()}`,
    generationId: `gen-${crypto.randomUUID()}`,
    generatedAt: '2026-09-01T00:00:00.000Z',
    sourceWorkbookId: `workbook-${crypto.randomUUID()}`,
    ...overrides,
  };
}

async function world(): Promise<{ testApp: TestApp; token: string; userId: string }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken, userId } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  return { testApp, token: accessToken, userId };
}

async function uploadRaw(
  testApp: TestApp,
  token: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request('/api/v1/configuration-releases', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
  const parsed: Record<string, unknown> = await response.json();
  return { status: response.status, body: parsed };
}

async function upload(
  testApp: TestApp,
  token: string,
  overrides: Partial<UploadBody> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return uploadRaw(testApp, token, uploadBody(overrides));
}

async function publish(
  testApp: TestApp,
  token: string,
  formId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request(`/api/v1/configuration-releases/${formId}/publish`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  const body: Record<string, unknown> = await response.json();
  return { status: response.status, body };
}

async function rollback(
  testApp: TestApp,
  token: string,
  formId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request(`/api/v1/configuration-releases/${formId}/rollback`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  const body: Record<string, unknown> = await response.json();
  return { status: response.status, body };
}

async function history(
  testApp: TestApp,
  token: string,
): Promise<{ status: number; body: Record<string, unknown>[] }> {
  const response = await testApp.request('/api/v1/configuration-releases', {
    headers: authHeaders(token),
  });
  const body: unknown = await response.json();
  return { status: response.status, body: Array.isArray(body) ? body : [] };
}

async function bulk(
  testApp: TestApp,
  token: string | undefined,
  formIds: readonly string[],
): Promise<{ status: number; body: { releases?: Record<string, unknown>[] } }> {
  const response = await testApp.request(
    `/api/v1/configuration-releases/bulk?formIds=${formIds.join(',')}`,
    { headers: token === undefined ? {} : authHeaders(token) },
  );
  const body: { releases?: Record<string, unknown>[] } = await response.json();
  return { status: response.status, body };
}

async function publicQuestionnaire(
  testApp: TestApp,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request('/api/v1/public/questionnaire');
  const body: Record<string, unknown> = await response.json();
  return { status: response.status, body };
}

/** A row for a direct, non-API insert — used only to exercise the database itself. */
function releaseRow(overrides: Partial<NewConfigurationRelease> = {}): NewConfigurationRelease {
  return {
    id: crypto.randomUUID(),
    questionnaireJson: '{}',
    rulesJson: '{}',
    questionnaireHash: 'hash',
    rulesHash: 'hash',
    generationId: 'gen',
    generatedAt: '2026-09-01T00:00:00.000Z',
    sourceWorkbookId: 'wb',
    status: 'draft',
    createdAt: '2026-09-01T00:00:00.000Z',
    createdByUserId: null,
    publishedAt: null,
    publishedByUserId: null,
    ...overrides,
  };
}

/**
 * The exact row migration `0040` seeded, captured once before any test
 * mutates it, so `beforeEach` can put the baseline back exactly as found
 * rather than guessing a "published" state.
 */
let baselineSnapshot: ConfigurationRelease;

beforeAll(async () => {
  const rows = await db
    .select()
    .from(configurationReleases)
    .where(eq(configurationReleases.id, BASELINE_FORM_ID));
  const [row] = rows;
  if (row === undefined) {
    throw new Error('The baseline configuration release migration 0040 seeds is missing');
  }
  baselineSnapshot = row;
});

beforeEach(async () => {
  // Every other release and every publication is this file's own mess to
  // clean up; the baseline is migration 0040's, restored to exactly what it
  // seeded rather than deleted, because it is not this file's row to remove.
  await db.delete(configurationReleasePublications);
  await db.delete(configurationReleases).where(ne(configurationReleases.id, BASELINE_FORM_ID));
  await db
    .update(configurationReleases)
    .set({
      status: baselineSnapshot.status,
      publishedAt: baselineSnapshot.publishedAt,
      publishedByUserId: baselineSnapshot.publishedByUserId,
    })
    .where(eq(configurationReleases.id, BASELINE_FORM_ID));
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('the baseline release migration 0040 seeds', () => {
  it('publishes exactly one release, with the fixed baseline id and non-empty documents', async () => {
    const published = await db
      .select()
      .from(configurationReleases)
      .where(eq(configurationReleases.status, 'published'));

    expect(published).toHaveLength(1);
    expect(published[0]?.id).toBe(BASELINE_FORM_ID);
    expect(published[0]?.questionnaireJson.length).toBeGreaterThan(0);
    expect(published[0]?.rulesJson.length).toBeGreaterThan(0);
  });
});

describe('uq_configuration_releases_one_published — the partial unique index', () => {
  it('refuses a second published row at the database level', async () => {
    let error: unknown;
    try {
      await db.insert(configurationReleases).values(releaseRow({ status: 'published' }));
    } catch (caught) {
      error = caught;
    }

    expect(isUniqueViolation(error, 'configuration_releases.status')).toBe(true);
  });

  it('allows more than one draft row at once', async () => {
    await db.insert(configurationReleases).values(releaseRow({ status: 'draft' }));
    await db.insert(configurationReleases).values(releaseRow({ status: 'draft' }));

    const drafts = await db
      .select()
      .from(configurationReleases)
      .where(eq(configurationReleases.status, 'draft'));
    expect(drafts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('uploading a release', () => {
  it('stores an admin upload as a draft under a new formId, crediting the uploader', async () => {
    const { testApp, token, userId } = await world();
    const { status, body } = await upload(testApp, token);

    expect(status).toBe(201);
    expect(body).toMatchObject({ status: 'draft', createdByUserId: userId });
    expect(body.formId).not.toBe(BASELINE_FORM_ID);
    expect(typeof body.formId).toBe('string');
    expect(body.formId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('stores an arbitrary, malformed questionnaire and rules string byte-for-byte, unvalidated', async () => {
    const { testApp, token } = await world();
    const malformedQuestionnaire = '{not json';
    const oddlySpacedRules = '  \t\nweird   spacing\n\n  ';

    const { status, body } = await upload(testApp, token, {
      questionnaire: malformedQuestionnaire,
      rules: oddlySpacedRules,
    });
    expect(status).toBe(201);
    const formId = body.formId as string;

    // Read back through a different route entirely, proving persistence
    // rather than an echo of the request.
    const { status: bulkStatus, body: bulkBody } = await bulk(testApp, token, [formId]);
    expect(bulkStatus).toBe(200);
    expect(bulkBody.releases?.[0]?.questionnaire).toBe(malformedQuestionnaire);
    expect(bulkBody.releases?.[0]?.rules).toBe(oddlySpacedRules);
  });

  it('refuses a team lead', async () => {
    const { testApp } = await world();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const { status } = await upload(testApp, accessToken);
    expect(status).toBe(403);
  });

  it('refuses a fuel administrator', async () => {
    const { testApp } = await world();
    const { accessToken } = await devLogin(testApp, {
      email: 'fuel@foodbank.org',
      role: 'fuel_admin',
    });

    const { status } = await upload(testApp, accessToken);
    expect(status).toBe(403);
  });

  it('refuses a body missing a required field', async () => {
    const { testApp, token } = await world();
    const { sourceWorkbookId: _sourceWorkbookId, ...incomplete } = uploadBody();

    const { status } = await uploadRaw(testApp, token, incomplete);
    expect(status).toBe(400);
  });

  it('refuses a questionnaire over 500,000 characters', async () => {
    const { testApp, token } = await world();
    const { status } = await upload(testApp, token, { questionnaire: 'x'.repeat(500_001) });
    expect(status).toBe(400);
  });
});

describe('publishing a draft', () => {
  it('makes the draft the release in use, superseding the one before it, timestamped from the clock', async () => {
    const { testApp, token, userId } = await world();
    const { body: created } = await upload(testApp, token);
    const formId = created.formId as string;

    const { status, body } = await publish(testApp, token, formId);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: 'published',
      publishedAt: NOW,
      publishedByUserId: userId,
    });

    const rows = await db.select().from(configurationReleases);
    const published = rows.filter((row) => row.status === 'published');
    expect(published).toHaveLength(1);
    expect(published[0]?.id).toBe(formId);

    const baseline = rows.find((row) => row.id === BASELINE_FORM_ID);
    expect(baseline?.status).toBe('superseded');
  });

  it('leaves questionnaire, rules and hashes exactly as uploaded', async () => {
    const { testApp, token } = await world();
    const sent = uploadBody({ questionnaire: '{malformed', rules: 'not json either' });
    const { body: created } = await uploadRaw(testApp, token, sent);
    const formId = created.formId as string;

    const { status, body: published } = await publish(testApp, token, formId);
    expect(status).toBe(200);
    expect(published).toMatchObject({
      questionnaire: sent.questionnaire,
      rules: sent.rules,
      questionnaireHash: sent.questionnaireHash,
      rulesHash: sent.rulesHash,
    });
  });

  it('refuses to publish the release already in use', async () => {
    const { testApp, token } = await world();
    const { status } = await publish(testApp, token, BASELINE_FORM_ID);
    expect(status).toBe(409);
  });

  it('refuses to publish a superseded release — rollback is the only way back', async () => {
    const { testApp, token } = await world();
    const { body: created } = await upload(testApp, token);
    const formId = created.formId as string;
    await publish(testApp, token, formId); // baseline is now superseded

    const { status } = await publish(testApp, token, BASELINE_FORM_ID);
    expect(status).toBe(409);
  });

  it('refuses to publish a draft twice', async () => {
    const { testApp, token } = await world();
    const { body: created } = await upload(testApp, token);
    const formId = created.formId as string;
    const first = await publish(testApp, token, formId);
    expect(first.status).toBe(200);

    const { status } = await publish(testApp, token, formId);
    expect(status).toBe(409);
  });

  it('404s on an unknown release id', async () => {
    const { testApp, token } = await world();
    const { status } = await publish(testApp, token, crypto.randomUUID());
    expect(status).toBe(404);
  });

  it('refuses a team lead', async () => {
    const { testApp, token } = await world();
    const { body: created } = await upload(testApp, token);
    const formId = created.formId as string;

    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });
    const { status } = await publish(testApp, accessToken, formId);
    expect(status).toBe(403);
  });
});

describe('rolling back to a superseded release', () => {
  async function supersededSetup(): Promise<{ testApp: TestApp; token: string; userId: string }> {
    const { testApp, token, userId } = await world();
    const { body: created } = await upload(testApp, token);
    const formId = created.formId as string;
    const published = await publish(testApp, token, formId);
    expect(published.status).toBe(200);
    return { testApp, token, userId };
  }

  it('publishes the superseded baseline again, superseding the release that replaced it', async () => {
    const { testApp, token } = await supersededSetup();

    const { status, body } = await rollback(testApp, token, BASELINE_FORM_ID);
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'published' });

    const rows = await db.select().from(configurationReleases);
    const published = rows.filter((row) => row.status === 'published');
    expect(published).toHaveLength(1);
    expect(published[0]?.id).toBe(BASELINE_FORM_ID);
  });

  it('refuses to roll back to the release currently in use', async () => {
    const { testApp, token } = await world();
    const { body: created } = await upload(testApp, token);
    const formId = created.formId as string;
    const published = await publish(testApp, token, formId);
    expect(published.status).toBe(200);

    const { status } = await rollback(testApp, token, formId);
    expect(status).toBe(409);
  });

  it('refuses to roll back to a draft', async () => {
    const { testApp, token } = await world();
    const { body: created } = await upload(testApp, token);

    const { status } = await rollback(testApp, token, created.formId as string);
    expect(status).toBe(409);
  });

  it('404s on an unknown release id', async () => {
    const { testApp, token } = await world();
    const { status } = await rollback(testApp, token, crypto.randomUUID());
    expect(status).toBe(404);
  });

  it('refuses a team lead', async () => {
    const { testApp } = await supersededSetup();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const { status } = await rollback(testApp, accessToken, BASELINE_FORM_ID);
    expect(status).toBe(403);
  });
});

describe('configuration_release_publications — the audit trail', () => {
  it('appends one row per successful publish or rollback, and none for a refused one', async () => {
    const { testApp, token, userId } = await world();
    const { body: created } = await upload(testApp, token);
    const formId = created.formId as string;

    // Refused: a draft cannot be rolled back to.
    const refusedRollback = await rollback(testApp, token, formId);
    expect(refusedRollback.status).toBe(409);

    const publishedNow = await publish(testApp, token, formId);
    expect(publishedNow.status).toBe(200);

    // Refused: already published.
    const refusedPublish = await publish(testApp, token, formId);
    expect(refusedPublish.status).toBe(409);

    const rolledBack = await rollback(testApp, token, BASELINE_FORM_ID);
    expect(rolledBack.status).toBe(200);

    const rows = await db
      .select()
      .from(configurationReleasePublications)
      .orderBy(configurationReleasePublications.occurredAt);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ releaseId: formId, action: 'publish', actorUserId: userId });
    expect(rows[1]).toMatchObject({
      releaseId: BASELINE_FORM_ID,
      action: 'rollback',
      actorUserId: userId,
    });
  });
});

describe('concurrent publishes', () => {
  it('leaves exactly one published release when two different drafts are published at once', async () => {
    const { testApp, token } = await world();
    const a = (await upload(testApp, token)).body.formId as string;
    const b = (await upload(testApp, token)).body.formId as string;

    const [first, second] = await Promise.all([
      publish(testApp, token, a),
      publish(testApp, token, b),
    ]);

    // Not asserting which one wins — only that the invariant the unique index
    // exists to protect held under concurrent writers.
    expect([first.status, second.status].every((status) => status === 200 || status === 409)).toBe(
      true,
    );

    const published = await db
      .select()
      .from(configurationReleases)
      .where(eq(configurationReleases.status, 'published'));
    expect(published).toHaveLength(1);
  });

  it('lets exactly one of two concurrent publishes of the same draft succeed, and records exactly one publication', async () => {
    const { testApp, token } = await world();
    const draftId = (await upload(testApp, token)).body.formId as string;

    const [first, second] = await Promise.all([
      publish(testApp, token, draftId),
      publish(testApp, token, draftId),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);

    const publications = await db
      .select()
      .from(configurationReleasePublications)
      .where(eq(configurationReleasePublications.releaseId, draftId));
    expect(publications).toHaveLength(1);

    const published = await db
      .select()
      .from(configurationReleases)
      .where(eq(configurationReleases.status, 'published'));
    expect(published).toHaveLength(1);
    expect(published[0]?.id).toBe(draftId);
  });
});

describe('GET /public/questionnaire', () => {
  it('serves exactly the formId and questionnaire of the release in use, unauthenticated', async () => {
    const { testApp } = await world();
    const { status, body } = await publicQuestionnaire(testApp);

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['formId', 'questionnaire']);
    expect(body.formId).toBe(BASELINE_FORM_ID);
  });

  it('serves the newly published release once one is published', async () => {
    const { testApp, token } = await world();
    const sent = uploadBody({ questionnaire: JSON.stringify({ version: 2, pages: [] }) });
    const { body: created } = await uploadRaw(testApp, token, sent);
    const formId = created.formId as string;
    const published = await publish(testApp, token, formId);
    expect(published.status).toBe(200);

    const { body } = await publicQuestionnaire(testApp);
    expect(body).toEqual({ formId, questionnaire: sent.questionnaire });
  });

  it('serves the earlier release again once a rollback undoes the publish', async () => {
    const { testApp, token } = await world();
    const { body: created } = await upload(testApp, token);
    const formId = created.formId as string;
    await publish(testApp, token, formId);

    const rolledBack = await rollback(testApp, token, BASELINE_FORM_ID);
    expect(rolledBack.status).toBe(200);

    const { body } = await publicQuestionnaire(testApp);
    expect(body.formId).toBe(BASELINE_FORM_ID);
  });
});

describe('GET /configuration-releases — the history', () => {
  it('lists newest upload first, without exposing questionnaire or rules', async () => {
    const early = buildTestApp({ clock: fixedClock('2026-09-01T00:00:00.000Z') });
    const { accessToken: earlyToken } = await devLogin(early, { email: 'admin@foodbank.org' });
    const earlyId = (await upload(early, earlyToken)).body.formId as string;

    const late = buildTestApp({ clock: fixedClock('2026-09-02T00:00:00.000Z') });
    const { accessToken: lateToken } = await devLogin(late, { email: 'admin@foodbank.org' });
    const lateId = (await upload(late, lateToken)).body.formId as string;

    const { status, body } = await history(late, lateToken);
    expect(status).toBe(200);

    const ids = body.map((item) => item.formId);
    expect(ids.indexOf(lateId)).toBeLessThan(ids.indexOf(earlyId));

    for (const item of body) {
      expect(item).not.toHaveProperty('questionnaire');
      expect(item).not.toHaveProperty('rules');
    }
  });

  it('refuses a team lead', async () => {
    const { testApp } = await world();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const { status } = await history(testApp, accessToken);
    expect(status).toBe(403);
  });
});

describe('GET /configuration-releases/bulk', () => {
  it('is readable by an admin and a team lead, and gives both the rules as well as the questionnaire', async () => {
    const { testApp, token } = await world();
    const sent = uploadBody();
    const { body: created } = await uploadRaw(testApp, token, sent);
    const formId = created.formId as string;

    for (const login of [
      { email: 'admin@foodbank.org' },
      { email: 'lead@foodbank.org', role: 'team_lead' as const },
    ]) {
      const { accessToken } = await devLogin(testApp, login);
      const { status, body } = await bulk(testApp, accessToken, [formId]);
      expect(status).toBe(200);
      expect(body.releases?.[0]).toMatchObject({
        formId,
        questionnaire: sent.questionnaire,
        rules: sent.rules,
      });
    }
  });

  it('is readable by a fuel administrator, but gives them the questionnaire without the rules — they label answers and never pick', async () => {
    const { testApp, token } = await world();
    const sent = uploadBody();
    const { body: created } = await uploadRaw(testApp, token, sent);
    const formId = created.formId as string;

    const { accessToken } = await devLogin(testApp, {
      email: 'fuel@foodbank.org',
      role: 'fuel_admin',
    });
    const { status, body } = await bulk(testApp, accessToken, [formId]);
    expect(status).toBe(200);
    const release = body.releases?.[0];
    expect(release).toMatchObject({ formId, questionnaire: sent.questionnaire });
    expect(release).not.toHaveProperty('rules');
  });

  it('refuses an unauthenticated caller', async () => {
    const { testApp, token } = await world();
    const { body: created } = await upload(testApp, token);

    const { status } = await bulk(testApp, undefined, [created.formId as string]);
    expect(status).toBe(401);
  });

  it('omits an id that names no release, rather than failing the call', async () => {
    const { testApp, token } = await world();
    const { status, body } = await bulk(testApp, token, [crypto.randomUUID()]);
    expect(status).toBe(200);
    expect(body.releases).toEqual([]);
  });

  it('returns one release for a duplicated id', async () => {
    const { testApp, token } = await world();
    const { status, body } = await bulk(testApp, token, [BASELINE_FORM_ID, BASELINE_FORM_ID]);
    expect(status).toBe(200);
    expect(body.releases).toHaveLength(1);
  });

  it('refuses more than 50 ids', async () => {
    const { testApp, token } = await world();
    const tooMany = Array.from({ length: MAX_BULK_FORM_IDS + 1 }, () => crypto.randomUUID());

    const { status } = await bulk(testApp, token, tooMany);
    expect(status).toBe(400);
  });

  it('refuses an id that is not a uuid', async () => {
    const { testApp, token } = await world();
    const { status } = await bulk(testApp, token, ['not-a-uuid', BASELINE_FORM_ID]);
    expect(status).toBe(400);
  });

  it('refuses a call with no formIds at all', async () => {
    const { testApp, token } = await world();
    const response = await testApp.request('/api/v1/configuration-releases/bulk', {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /configuration-releases/config', () => {
  const WORKBOOK_ID = 'config-workbook-abc123';
  const OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

  async function configRequest(bindings: Record<string, string>, role?: 'team_lead') {
    const testApp = buildTestApp({ clock: fixedClock(NOW), bindings });
    const { accessToken } = await devLogin(testApp, {
      email: role === undefined ? 'admin@foodbank.org' : 'lead@foodbank.org',
      ...(role === undefined ? {} : { role }),
    });
    return testApp.request('/api/v1/configuration-releases/config', {
      headers: authHeaders(accessToken),
    });
  }

  it('hands an administrator the configuration workbook and the OAuth client the extract uses', async () => {
    const response = await configRequest({
      CONFIGURATION_SPREADSHEET_ID: WORKBOOK_ID,
      GOOGLE_CLIENT_ID: OAUTH_CLIENT_ID,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      spreadsheetId: WORKBOOK_ID,
      googleClientId: OAUTH_CLIENT_ID,
    });
  });

  it('reports itself unconfigured, with neither value, when the workbook is not set', async () => {
    const response = await configRequest({
      CONFIGURATION_SPREADSHEET_ID: '',
      GOOGLE_CLIENT_ID: OAUTH_CLIENT_ID,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false });
  });

  it('reports itself unconfigured when the OAuth client is not set', async () => {
    const response = await configRequest({
      CONFIGURATION_SPREADSHEET_ID: WORKBOOK_ID,
      GOOGLE_CLIENT_ID: '',
    });
    expect(await response.json()).toEqual({ configured: false });
  });

  it('never hands out the extract spreadsheet in place of the configuration workbook', async () => {
    const response = await configRequest({
      CONFIGURATION_SPREADSHEET_ID: '',
      GOOGLE_SHEETS_SPREADSHEET_ID: 'extract-sheet-xyz',
      GOOGLE_CLIENT_ID: OAUTH_CLIENT_ID,
    });
    expect(await response.json()).toEqual({ configured: false });
  });

  it('is refused to a team leader', async () => {
    const response = await configRequest(
      { CONFIGURATION_SPREADSHEET_ID: WORKBOOK_ID, GOOGLE_CLIENT_ID: OAUTH_CLIENT_ID },
      'team_lead',
    );
    expect(response.status).toBe(403);
  });
});
