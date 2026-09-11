import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { referralImports } from '../src/db/schema/dev-test-imports.ts';
import { referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { sessions } from '../src/db/schema/sessions.ts';
import { smsMessages } from '../src/db/schema/sms.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';

/**
 * `POST /dev-test/referral-imports` — the client's bulk test-data loader. See
 * `src/modules/dev-test/dev-test-imports.service.ts` for the design this
 * proves: forced `active`/no authorisation check, no booking cutoff, capacity
 * checked for the whole batch, and `db.batch()` atomicity/idempotency via
 * `referral_imports.import_key`.
 */

const db = createDatabase(env.DB);
const PATH = '/api/v1/dev-test/referral-imports';

// A London date and time that straddle nothing in particular — chosen only so
// a session dated the same day is unambiguously "today" in both UTC and
// London, which is what the cutoff-bypass test needs.
const NOW = '2026-09-15T09:00:00.000Z';
const TODAY = '2026-09-15';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

async function adminApp(): Promise<{ testApp: TestApp; token: string }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  return { testApp, token: accessToken };
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
      sessionDate: '2026-09-20',
      startTime: '10:00',
      durationMinutes: 120,
      location: 'Church Hall',
      capacity: 25,
      deliveryCapacity: 25,
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  const { id }: { id: string } = await response.json();
  return id;
}

async function createReason(testApp: TestApp, token: string): Promise<string> {
  const response = await testApp.request('/api/v1/referral-reasons', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ code: 'benefit_delay', label: 'Benefit delay' }),
  });
  expect(response.status).toBe(201);
  const { id }: { id: string } = await response.json();
  return id;
}

async function retireReason(testApp: TestApp, token: string, reasonId: string): Promise<void> {
  const response = await testApp.request(`/api/v1/referral-reasons/${reasonId}`, {
    method: 'PATCH',
    headers: json(token),
    body: JSON.stringify({ isActive: false }),
  });
  expect(response.status).toBe(200);
}

async function cancelSession(testApp: TestApp, token: string, id: string): Promise<void> {
  const response = await testApp.request(`/api/v1/sessions/${id}/cancel`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
}

async function confirmSession(testApp: TestApp, token: string, id: string): Promise<void> {
  const response = await testApp.request(`/api/v1/sessions/${id}/confirm`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
}

interface World {
  readonly sessionId: string;
  readonly reasonId: string;
}

async function setUpWorld(
  testApp: TestApp,
  token: string,
  sessionOverrides: Record<string, unknown> = {},
): Promise<World> {
  const sessionId = await createSession(testApp, token, sessionOverrides);
  const reasonId = await createReason(testApp, token);
  return { sessionId, reasonId };
}

/** One prepared scenario matching `importReferralSchema`. */
function scenario(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    referrerName: 'Test Referrer',
    referrerEmail: 'referrer@example.test',
    referrerOrganisation: 'Test Org',
    referrerPhone: '01483 000111',
    refereeFirstName: 'Alice',
    refereeSurname: 'Testwood',
    refereeDateOfBirth: '1985-03-14',
    refereeAddress: '12 Bramble Cottages',
    refereePostcode: 'GU1 4AA',
    refereePhone: '07700 900123',
    adults: 2,
    children: 1,
    collectionMethod: 'collection',
    needsFuelHelp: false,
    answers: {},
    ...overrides,
  };
}

function importBody(
  world: World,
  referralsInput: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    importKey: crypto.randomUUID(),
    sessionId: world.sessionId,
    reasonId: world.reasonId,
    referrals: referralsInput,
    ...overrides,
  };
}

interface ImportResponseBody {
  readonly sessionId?: string;
  readonly importKey?: string;
  readonly referrals?: readonly { readonly sourceIndex: number; readonly referralId: string }[];
  readonly error?: { readonly code: string; readonly message: string };
}

async function postImport(
  testApp: TestApp,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: ImportResponseBody }> {
  const response = await testApp.request(PATH, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
  const parsed: ImportResponseBody = await response.json();
  return { status: response.status, body: parsed };
}

async function referralsOnSession(sessionId: string) {
  return db.select().from(referrals).where(eq(referrals.sessionId, sessionId));
}

beforeEach(async () => {
  await db.delete(referralImports);
  await db.delete(referrals);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(sessions);
  await db.delete(smsMessages);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('route existence is a build-time decision', () => {
  it('does not exist in production — 404, not 403', async () => {
    const testApp = buildTestApp({
      clock: fixedClock(NOW),
      bindings: {
        ENVIRONMENT: 'production',
        AUTH_MODE: 'google',
        TURNSTILE_SECRET_KEY: 'turnstile-secret',
        SMS_WEBHOOK_SECRET: 'sms-webhook-secret-long-enough',
        SMS_SIMULATE: undefined,
      },
    });

    const response = await testApp.request(PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
  });

  it('requires authentication outside production', async () => {
    const testApp = buildTestApp({ clock: fixedClock(NOW) });

    const response = await testApp.request(PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
  });

  it('refuses a team lead — admin only', async () => {
    const testApp = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await testApp.request(PATH, {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
  });
});

describe('happy path', () => {
  it('creates one active referral per prepared scenario, none authorised, 1-based sourceIndex matching request order', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);

    const scenarios = [
      scenario({ refereeFirstName: 'Alice' }),
      scenario({ refereeFirstName: 'Bea' }),
      scenario({ refereeFirstName: 'Cal' }),
    ];
    const { status, body } = await postImport(testApp, token, importBody(world, scenarios));

    expect(status).toBe(200);
    expect(body.sessionId).toBe(world.sessionId);
    expect(body.referrals).toHaveLength(3);
    body.referrals?.forEach((referral, index) => {
      expect(referral.sourceIndex).toBe(index + 1);
    });

    const created = await referralsOnSession(world.sessionId);
    expect(created).toHaveLength(3);
    for (const row of created) {
      expect(row.status).toBe('active');
      expect(row.authorisedReferrerId).toBeNull();
    }

    // The created ids in the response are exactly the created rows' ids.
    const createdIds = new Set(created.map((row) => row.id));
    for (const referral of body.referrals ?? []) {
      expect(createdIds.has(referral.referralId)).toBe(true);
    }
  });

  it('never checks referrerEmail against the authorised-referrer list, even when it matches', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);

    // An authorised-referrer entry that would ordinarily grant `active` on a
    // real submission — proving the check is skipped, not merely satisfied.
    await testApp.request('/api/v1/authorised-referrers', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        matchType: 'domain',
        matchValue: '*@example.test',
        organisationName: 'Example Referrers',
      }),
    });

    const { status } = await postImport(testApp, token, importBody(world, [scenario()]));
    expect(status).toBe(200);

    const [created] = await referralsOnSession(world.sessionId);
    expect(created?.authorisedReferrerId).toBeNull();
  });
});

describe('no booking-cutoff gate', () => {
  it('accepts a session dated today, which a real public submission would refuse', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token, { sessionDate: TODAY });

    // Confirm the real public path really would refuse this date: today's
    // sessions are never offered, whatever the time — see
    // `firstOfferableDate` in `sessions/public-window.ts`.
    const publicList = await testApp.request('/api/v1/public/sessions');
    const { sessions: offered }: { sessions: { id: string }[] } = await publicList.json();
    expect(offered.some((s) => s.id === world.sessionId)).toBe(false);

    const { status } = await postImport(testApp, token, importBody(world, [scenario()]));
    expect(status).toBe(200);

    const created = await referralsOnSession(world.sessionId);
    expect(created).toHaveLength(1);
  });
});

describe('capacity, checked against the whole batch', () => {
  it('refuses a batch that would exceed session capacity, creating none of it', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token, { capacity: 2, deliveryCapacity: 2 });

    const { status, body } = await postImport(
      testApp,
      token,
      importBody(world, [scenario(), scenario(), scenario()]),
    );

    expect(status).toBe(409);
    expect(body.error?.code).toBe('CONFLICT');

    const created = await referralsOnSession(world.sessionId);
    expect(created).toHaveLength(0);
  });

  it('accounts for referrals already on the session when sizing the batch', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token, { capacity: 2, deliveryCapacity: 2 });

    // One place already taken.
    const first = await postImport(testApp, token, importBody(world, [scenario()]));
    expect(first.status).toBe(200);

    // Only one place left; two more is refused, and nothing new is created.
    const second = await postImport(testApp, token, importBody(world, [scenario(), scenario()]));
    expect(second.status).toBe(409);

    const created = await referralsOnSession(world.sessionId);
    expect(created).toHaveLength(1);
  });
});

describe('delivery capacity, same shape as capacity', () => {
  it('refuses a batch of deliveries that would exceed delivery capacity, creating none of it', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token, { capacity: 25, deliveryCapacity: 2 });

    const { status } = await postImport(
      testApp,
      token,
      importBody(world, [
        scenario({ collectionMethod: 'delivery' }),
        scenario({ collectionMethod: 'delivery' }),
        scenario({ collectionMethod: 'delivery' }),
      ]),
    );

    expect(status).toBe(409);

    const created = await referralsOnSession(world.sessionId);
    expect(created).toHaveLength(0);
  });

  it('lets non-deliveries through even when delivery capacity alone would be exceeded', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token, { capacity: 25, deliveryCapacity: 1 });

    const { status } = await postImport(
      testApp,
      token,
      importBody(world, [
        scenario({ collectionMethod: 'delivery' }),
        scenario({ collectionMethod: 'collection' }),
      ]),
    );

    expect(status).toBe(200);
    const created = await referralsOnSession(world.sessionId);
    expect(created).toHaveLength(2);
  });
});

describe('the reason for referral must be active', () => {
  it('422s on a retired reason, creating nothing', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);
    await retireReason(testApp, token, world.reasonId);

    const { status, body } = await postImport(testApp, token, importBody(world, [scenario()]));

    expect(status).toBe(422);
    expect(body.error?.code).toBe('UNPROCESSABLE');
    expect(await referralsOnSession(world.sessionId)).toHaveLength(0);
  });

  it('422s on a reasonId that has never existed, creating nothing', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);

    const { status } = await postImport(
      testApp,
      token,
      importBody(world, [scenario()], { reasonId: crypto.randomUUID() }),
    );

    expect(status).toBe(422);
    expect(await referralsOnSession(world.sessionId)).toHaveLength(0);
  });
});

describe('the session must exist and be open', () => {
  it('404s on a session that does not exist', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);

    const { status } = await postImport(
      testApp,
      token,
      importBody(world, [scenario()], { sessionId: crypto.randomUUID() }),
    );

    expect(status).toBe(404);
  });

  it('409s on a cancelled session, creating nothing', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);
    await cancelSession(testApp, token, world.sessionId);

    const { status } = await postImport(testApp, token, importBody(world, [scenario()]));

    expect(status).toBe(409);
    expect(await referralsOnSession(world.sessionId)).toHaveLength(0);
  });

  it('409s on a confirmed session, creating nothing', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);
    await confirmSession(testApp, token, world.sessionId);

    const { status } = await postImport(testApp, token, importBody(world, [scenario()]));

    expect(status).toBe(409);
    expect(await referralsOnSession(world.sessionId)).toHaveLength(0);
  });
});

describe('referrerEmail is restricted to example.test', () => {
  it('400s at validation on a non-example.test address, before anything is created', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);

    const { status, body } = await postImport(
      testApp,
      token,
      importBody(world, [scenario({ referrerEmail: 'someone@realcharity.org' })]),
    );

    expect(status).toBe(400);
    expect(body.error?.code).toBe('BAD_REQUEST');
    expect(await referralsOnSession(world.sessionId)).toHaveLength(0);
  });
});

describe('idempotency', () => {
  it('creates the referrals exactly once when two identical calls race', async () => {
    // The sequential replay below is also caught by the up-front
    // findByImportKey check. **This** test is what proves the unique index on
    // referral_imports.import_key: both requests can read "no existing row"
    // before either writes, so only the guard — the batch's insert failing on
    // a unique violation, caught and replayed by replayOrConflict — stops the
    // referrals being created twice. Mirrors
    // `attendance.test.ts`'s "moves stock once when two requests arrive at
    // the same moment".
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);
    const body = importBody(world, [scenario(), scenario()]);

    const [first, second] = await Promise.all([
      postImport(testApp, token, body),
      postImport(testApp, token, body),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.body).toEqual(second.body);

    const created = await referralsOnSession(world.sessionId);
    expect(created).toHaveLength(2);
  });

  it('replays the identical result for a matching repeat call, creating no second set of rows', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);
    const body = importBody(world, [scenario(), scenario()]);

    const first = await postImport(testApp, token, body);
    expect(first.status).toBe(200);

    const second = await postImport(testApp, token, body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('replays a matching call even when `answers` keys arrive in a different order', async () => {
    // hashRequest canonicalises `answers` before hashing precisely so this
    // does not happen: `answers` is a z.record, and unlike the fixed-shape
    // fields Zod does not reorder a record's own keys, so two semantically
    // identical requests built with different key insertion order must still
    // be recognised as the same import.
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);
    const importKey = crypto.randomUUID();

    const first = await postImport(testApp, token, {
      ...importBody(world, [scenario({ answers: { a: 1, b: 2 } })]),
      importKey,
    });
    expect(first.status).toBe(200);

    const second = await postImport(testApp, token, {
      ...importBody(world, [scenario({ answers: { b: 2, a: 1 } })]),
      importKey,
    });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    expect(await referralsOnSession(world.sessionId)).toHaveLength(1);
  });

  it('409s a reused importKey sent with a different sessionId, creating nothing new', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);
    const otherSessionId = await createSession(testApp, token, { sessionDate: '2026-09-21' });

    const body = importBody(world, [scenario()]);
    const first = await postImport(testApp, token, body);
    expect(first.status).toBe(200);

    const second = await postImport(testApp, token, {
      ...body,
      sessionId: otherSessionId,
    });
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('CONFLICT');

    expect(await referralsOnSession(world.sessionId)).toHaveLength(1);
    expect(await referralsOnSession(otherSessionId)).toHaveLength(0);
  });

  it('409s a reused importKey sent with a different referrals array, creating nothing new', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);
    const body = importBody(world, [scenario({ adults: 2 })]);

    const first = await postImport(testApp, token, body);
    expect(first.status).toBe(200);

    const second = await postImport(testApp, token, {
      ...body,
      referrals: [scenario({ adults: 3 })],
    });
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('CONFLICT');

    expect(await referralsOnSession(world.sessionId)).toHaveLength(1);
  });
});

describe('atomicity on a rejected batch', () => {
  // A malformed referral is refused entirely by Zod before the handler — and
  // therefore before any database work — starts, so there is no distinct
  // "some rows already staged" failure mode to construct for this route: Zod
  // parses the whole `referrals` array in one call, and a single invalid
  // element fails the whole request. This test proves that guarantee holds in
  // practice (the valid sibling is not created) rather than asserting it only
  // from reading the code.
  it('creates nothing when one of several referrals fails Zod validation', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);

    const { status } = await postImport(
      testApp,
      token,
      importBody(world, [scenario(), scenario({ adults: 0 })]),
    );

    expect(status).toBe(400);
    expect(await referralsOnSession(world.sessionId)).toHaveLength(0);
  });
});

describe('no side effects', () => {
  it('sends no SMS as part of an import', async () => {
    const { testApp, token } = await adminApp();
    const world = await setUpWorld(testApp, token);

    const { status } = await postImport(testApp, token, importBody(world, [scenario()]));
    expect(status).toBe(200);

    expect(await db.select().from(smsMessages)).toHaveLength(0);
  });
});
