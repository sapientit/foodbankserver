import { env } from 'cloudflare:workers';
import { and, eq, ne } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import {
  configurationReleasePublications,
  configurationReleases,
} from '../src/db/schema/configuration-releases.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  BASELINE_FORM_ID,
  setUpReferralWorld,
  submitReferral,
  UNKNOWN_REFERRER,
  type ReferralWorld,
} from './helpers/referral-fixtures.ts';

/**
 * How `formId` — the release a referral was made under — behaves across
 * submission, copy, re-refer and amendment. `INITIAL_SPEC1.txt`,
 * `#referral`, `#Copying a referral`. Migration `0040`,
 * `src/modules/configuration-releases/*`.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

let clientIpCounter = 0;
function nextClientIp(): string {
  clientIpCounter += 1;
  return `203.0.115.${String(clientIpCounter)}`;
}

async function world(): Promise<{ testApp: TestApp; token: string; world: ReferralWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const w = await setUpReferralWorld(testApp, accessToken);
  return { testApp, token: accessToken, world: w };
}

interface UploadOverrides {
  questionnaire?: string;
  rules?: string;
}

async function uploadDraft(
  testApp: TestApp,
  token: string,
  overrides: UploadOverrides = {},
): Promise<string> {
  const response = await testApp.request('/api/v1/configuration-releases', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      questionnaire: overrides.questionnaire ?? JSON.stringify({ version: 2, pages: [] }),
      rules: overrides.rules ?? JSON.stringify({ rules: [] }),
      questionnaireHash: `q-${crypto.randomUUID()}`,
      rulesHash: `r-${crypto.randomUUID()}`,
      generationId: `gen-${crypto.randomUUID()}`,
      generatedAt: '2026-08-01T00:00:00.000Z',
      sourceWorkbookId: `workbook-${crypto.randomUUID()}`,
    }),
  });
  expect(response.status).toBe(201);
  const { formId }: { formId: string } = await response.json();
  return formId;
}

async function publishRelease(testApp: TestApp, token: string, formId: string): Promise<void> {
  const response = await testApp.request(`/api/v1/configuration-releases/${formId}/publish`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
}

/** Uploads a fresh draft and publishes it in one step, returning its id. */
async function publishNewRelease(testApp: TestApp, token: string): Promise<string> {
  const formId = await uploadDraft(testApp, token);
  await publishRelease(testApp, token, formId);
  return formId;
}

async function getReferral(
  testApp: TestApp,
  token: string,
  id: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request(`/api/v1/referrals/${id}`, {
    headers: authHeaders(token),
  });
  const body: Record<string, unknown> = await response.json();
  return { status: response.status, body };
}

async function createSession(
  testApp: TestApp,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await testApp.request('/api/v1/sessions', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      sessionDate: '2026-08-18',
      startTime: '10:00',
      durationMinutes: 120,
      location: 'Annexe',
      capacity: 25,
      deliveryCapacity: 25,
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  const { id }: { id: string } = await response.json();
  return id;
}

async function copyReferral(
  testApp: TestApp,
  token: string,
  id: string,
  body: { sessionId: string; acknowledgeOverCapacity?: boolean },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request(`/api/v1/referrals/${id}/copy`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
  const parsed: Record<string, unknown> = await response.json();
  return { status: response.status, body: parsed };
}

async function reRefer(
  testApp: TestApp,
  token: string,
  sourceId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request(`/api/v1/referrals/${sourceId}/re-refer`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
  const parsed: Record<string, unknown> = await response.json();
  return { status: response.status, body: parsed };
}

/** A realistic re-refer body — the current form, filled in for the household. */
function reReferBody(w: ReferralWorld, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: w.sessionId,
    reasonId: w.reasonId,
    refereeFirstName: 'Alice',
    refereeSurname: 'Wintergreen',
    refereeDateOfBirth: '1985-03-14',
    refereeAddress: '12 Bramble Cottages',
    refereePostcode: 'GU1 4AA',
    refereePhone: '07700 900123',
    adults: 2,
    children: 3,
    collectionMethod: 'collection',
    answers: { Dietary: 'no pork' },
    ...overrides,
  };
}

/** A referral rejected outright — the cheapest copy/re-refer-eligible starting point. */
async function rejectedOriginal(
  testApp: TestApp,
  token: string,
  w: ReferralWorld,
  overrides: Record<string, unknown> = {},
  clientIp?: string,
): Promise<string> {
  const { id } = await submitReferral(
    testApp,
    w,
    { ...UNKNOWN_REFERRER, ...overrides },
    { clientIp: clientIp ?? nextClientIp() },
  );
  const response = await testApp.request(`/api/v1/referrals/${id}/reject`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ comment: 'Not a referring organisation' }),
  });
  expect(response.status).toBe(200);
  return id;
}

beforeEach(async () => {
  // Deletion order matters: a referral can hold a foreign key to a
  // non-baseline release (`form_id`) and a release can hold one to a user
  // (`created_by_user_id` / `published_by_user_id`), so both must go before
  // the rows they point at are removed — referrals before releases, releases
  // before users.
  await db.delete(configurationReleasePublications);
  await db.delete(auditEvents);
  await db.delete(referrals);

  await db.delete(configurationReleases).where(eq(configurationReleases.status, 'draft'));

  // Undo any publish/rollback a previous test left behind, restoring the
  // baseline as the release in use — this file's own concern, since it is
  // the release every referral in it is expected to default to. Done before
  // sweeping up `superseded` rows, since the baseline itself may currently be
  // one and must never be among them.
  const publishedRows = await db
    .select({ id: configurationReleases.id })
    .from(configurationReleases)
    .where(eq(configurationReleases.status, 'published'));
  const published = publishedRows[0];
  if (published !== undefined && published.id !== BASELINE_FORM_ID) {
    await db.delete(configurationReleases).where(eq(configurationReleases.id, published.id));
    await db
      .update(configurationReleases)
      .set({ status: 'published', publishedByUserId: null })
      .where(eq(configurationReleases.id, BASELINE_FORM_ID));
  }
  await db
    .delete(configurationReleases)
    .where(
      and(
        eq(configurationReleases.status, 'superseded'),
        ne(configurationReleases.id, BASELINE_FORM_ID),
      ),
    );

  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('a public submission records which release it was made under', () => {
  it('records the release in use when no formId is sent', async () => {
    const { testApp, token, world: w } = await world();
    const currentFormId = await publishNewRelease(testApp, token);

    const { id, status } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    expect(status).toBe(201);

    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(row?.formId).toBe(currentFormId);
  });

  it('records the named formId when it is the release in use', async () => {
    const { testApp, token, world: w } = await world();
    const currentFormId = await publishNewRelease(testApp, token);

    const { id, status } = await submitReferral(
      testApp,
      w,
      { formId: currentFormId },
      { clientIp: nextClientIp() },
    );
    expect(status).toBe(201);

    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(row?.formId).toBe(currentFormId);
  });

  it('accepts a superseded release — a form loaded just before a publish is still a real form', async () => {
    const { testApp, token, world: w } = await world();
    // Publishing a new release supersedes the baseline without deleting it.
    await publishNewRelease(testApp, token);

    const { id, status } = await submitReferral(
      testApp,
      w,
      { formId: BASELINE_FORM_ID },
      { clientIp: nextClientIp() },
    );
    expect(status).toBe(201);

    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(row?.formId).toBe(BASELINE_FORM_ID);
  });

  it('refuses a draft release with a 422, and creates nothing', async () => {
    const { testApp, token, world: w } = await world();
    const draftFormId = await uploadDraft(testApp, token);

    const before = await db.select().from(referrals);
    const { status } = await submitReferral(
      testApp,
      w,
      { formId: draftFormId },
      { clientIp: nextClientIp() },
    );
    expect(status).toBe(422);

    const after = await db.select().from(referrals);
    expect(after).toHaveLength(before.length);
  });

  it('refuses an unknown formId with a 422, and creates nothing', async () => {
    const { testApp, world: w } = await world();
    const before = await db.select().from(referrals);

    const { status } = await submitReferral(
      testApp,
      w,
      { formId: crypto.randomUUID() },
      { clientIp: nextClientIp() },
    );
    expect(status).toBe(422);

    const after = await db.select().from(referrals);
    expect(after).toHaveLength(before.length);
  });
});

describe('copying a referral — the formId regression guard', () => {
  it('copies as before when the source is still under the release in use', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);
    const target = await createSession(testApp, token);

    const { status, body: copy } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(201);
    expect(copy.formId).toBe(BASELINE_FORM_ID);
  });

  it('refuses with a 409 once a newer release has been published, and creates nothing', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);
    await publishNewRelease(testApp, token);
    const target = await createSession(testApp, token);

    const before = await db.select().from(referrals);
    const { status } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(409);

    const after = await db.select().from(referrals);
    expect(after).toHaveLength(before.length);
  });
});

describe('re-referring on today’s form', () => {
  it('refuses a team lead outright', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const { status } = await reRefer(testApp, accessToken, id, reReferBody(w));
    expect(status).toBe(403);
  });

  it('refuses a source that can still be completed (active, no outcome)', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const { status } = await reRefer(testApp, token, id, reReferBody(w));
    expect(status).toBe(409);
  });

  it('refuses a body naming formId, even with every other field valid', async () => {
    const { testApp, token, world: w } = await world();

    const { status } = await reRefer(
      testApp,
      token,
      crypto.randomUUID(),
      reReferBody(w, { formId: BASELINE_FORM_ID }),
    );
    expect(status).toBe(400);
  });

  it('records the release in use, not the source’s, even when the source was made under the baseline', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);
    const [source] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(source?.formId).toBe(BASELINE_FORM_ID);

    const currentFormId = await publishNewRelease(testApp, token);
    expect(currentFormId).not.toBe(BASELINE_FORM_ID);

    const { status, body: created } = await reRefer(testApp, token, id, reReferBody(w));
    expect(status).toBe(201);
    expect(created.formId).toBe(currentFormId);
  });

  it('stores the answers exactly as sent, arbitrary keys and all', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);
    const answers = { Dietary: 'no pork', 'a weird$ key': { nested: [1, 2, 3] }, flag: true };

    const { status, body: created } = await reRefer(
      testApp,
      token,
      id,
      reReferBody(w, { answers }),
    );
    expect(status).toBe(201);
    expect(created.answers).toEqual(answers);
  });

  it('carries the household from the body, the referrer from the source, and stamps status, comment and note', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w, {
      referrerName: 'Jane Fieldsworth',
      referrerPhone: '01483 000111',
    });
    const [source] = await db.select().from(referrals).where(eq(referrals.id, id));
    if (source === undefined) throw new Error('source referral missing');

    const { status, body: created } = await reRefer(
      testApp,
      token,
      id,
      reReferBody(w, { refereeFirstName: 'Bob', refereeSurname: 'Newperson', adults: 5 }),
    );
    expect(status).toBe(201);
    expect(created).toMatchObject({
      // From the body — a household re-referred, not the same household copied.
      refereeFirstName: 'Bob',
      refereeSurname: 'Newperson',
      adults: 5,
      // From the source, carried forward unchanged.
      referrerName: source.referrerName,
      referrerOrganisation: source.referrerOrganisation,
      referrerEmail: source.referrerEmail,
      referrerPhone: source.referrerPhone,
      // Stamped exactly as a copy is.
      status: 'reviewed',
      reviewComment: null,
    });
  });

  it('notes the original’s referral date in London, and stamps referredAt from the clock — straddling the BST/GMT boundary', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);

    // London is on BST (UTC+1) in August: 23:30 UTC on the 20th is 00:30 the
    // next day in London — the date this test exists to catch a naive UTC read.
    const originalReferredAt = '2026-08-20T23:30:00.000Z';
    await db.update(referrals).set({ referredAt: originalReferredAt }).where(eq(referrals.id, id));

    const reReferApp = buildTestApp({ clock: fixedClock('2026-08-22T12:00:00.000Z') });
    const { accessToken: reReferToken } = await devLogin(reReferApp, {
      email: 'admin@foodbank.org',
    });

    const { status, body: created } = await reRefer(reReferApp, reReferToken, id, reReferBody(w));
    expect(status).toBe(201);
    expect(created.adminInfo).toBe('Copied from referral dated 2026-08-21');
    expect(created.referredAt).toBe('2026-08-22T12:00:00.000Z');
  });

  it('refuses an over-capacity session without acknowledgement, and accepts it with', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);
    const full = await createSession(testApp, token, { capacity: 0, deliveryCapacity: 0 });

    const refused = await reRefer(testApp, token, id, reReferBody(w, { sessionId: full }));
    expect(refused.status).toBe(409);

    const allowed = await reRefer(
      testApp,
      token,
      id,
      reReferBody(w, { sessionId: full, acknowledgeOverCapacity: true }),
    );
    expect(allowed.status).toBe(201);
  });

  it('refuses a reason for referral the charity has retired, with a 422', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);

    const deactivated = await testApp.request(`/api/v1/referral-reasons/${w.reasonId}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ isActive: false }),
    });
    expect(deactivated.status).toBe(200);

    const { status } = await reRefer(testApp, token, id, reReferBody(w));
    expect(status).toBe(422);
  });

  it('leaves the source referral completely untouched', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);
    const before = await getReferral(testApp, token, id);

    const target = await createSession(testApp, token);
    const { status } = await reRefer(testApp, token, id, reReferBody(w, { sessionId: target }));
    expect(status).toBe(201);

    const after = await getReferral(testApp, token, id);
    expect(after.body).toMatchObject({
      status: before.body.status,
      sessionId: before.body.sessionId,
      formId: before.body.formId,
    });
  });
});

describe('amending a referral never changes which release it was made under', () => {
  it('leaves formId unchanged after an answers amendment, even once a newer release is published', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    await publishNewRelease(testApp, token);

    const patched = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ answers: { Dietary: 'vegan now' } }),
    });
    expect(patched.status).toBe(200);
    const patchedBody: { formId: string | null } = await patched.json();
    expect(patchedBody.formId).toBe(BASELINE_FORM_ID);

    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(row?.formId).toBe(BASELINE_FORM_ID);
  });
});
