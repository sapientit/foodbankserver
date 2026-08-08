import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { loadConfig } from '../src/config/env.ts';
import { createDatabase } from '../src/db/client.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { purgeReferralPii } from '../src/modules/jobs/purge-pii.ts';
import { createLogger } from '../src/core/log.ts';
import { buildTestApp, devLogin } from './helpers/app.ts';
import { setUpReferralWorld, submission, submitReferral } from './helpers/referral-fixtures.ts';

const db = createDatabase(env.DB);
const SECRET = 'a-secret-that-is-at-least-32-characters';

beforeEach(async () => {
  await db.delete(stockLedger);
  await db.delete(parcelLines);
  await db.delete(parcels);
  await db.delete(pickLists);
  await db.delete(parcelGrid);
  await db.delete(modelParcels);
  await db.delete(auditEvents);
  await db.delete(referrals);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(stockItems);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('production refuses to start unsafely', () => {
  it('requires a Turnstile secret in production', () => {
    expect(() =>
      loadConfig({
        AUTH_JWT_SECRET: SECRET,
        ENVIRONMENT: 'production',
        AUTH_MODE: 'google',
      }),
    ).toThrow(/TURNSTILE_SECRET_KEY is required in production/);
  });

  it('requires a secret on the SMS webhook in production', () => {
    // The other unauthenticated write. It lands in `sms_messages`, which holds
    // a household's own words, so an unguarded one is worse than an open form.
    expect(() =>
      loadConfig({
        AUTH_JWT_SECRET: SECRET,
        ENVIRONMENT: 'production',
        AUTH_MODE: 'google',
        TURNSTILE_SECRET_KEY: 'turnstile-secret',
      }),
    ).toThrow(/SMS_WEBHOOK_SECRET is required in production/);
  });

  it('accepts a production configuration that has every control', () => {
    const config = loadConfig({
      AUTH_JWT_SECRET: SECRET,
      ENVIRONMENT: 'production',
      AUTH_MODE: 'google',
      TURNSTILE_SECRET_KEY: 'turnstile-secret',
      SMS_WEBHOOK_SECRET: 'sms-webhook-secret-long-enough',
      ALLOWED_ORIGINS: 'https://foodbank.example.org',
    });

    expect(config.turnstileSecret).toBe('turnstile-secret');
    expect(config.smsWebhookSecret).toBe('sms-webhook-secret-long-enough');
    expect(config.allowedOrigins).toEqual(['https://foodbank.example.org']);
  });

  it('leaves personal data alone until a retention period is set', () => {
    expect(loadConfig({ AUTH_JWT_SECRET: SECRET }).piiRetentionDays).toBeUndefined();
  });
});

describe('the bot check on referral submission', () => {
  it('refuses a submission with no token when Turnstile is configured', async () => {
    const testApp = buildTestApp({ bindings: { TURNSTILE_SECRET_KEY: 'test-secret' } });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission(world)),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('bot check');
    expect(await db.select().from(referrals)).toHaveLength(0);
  });

  it('accepts a submission whose token Cloudflare confirms', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, 'error-codes': [] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const testApp = buildTestApp({ bindings: { TURNSTILE_SECRET_KEY: 'test-secret' } });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-turnstile-response': 'a-token' },
      body: JSON.stringify(submission(world)),
    });

    expect(response.status).toBe(201);

    // The secret goes to Cloudflare and nowhere else.
    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(call?.[1]?.body).toContain('test-secret');
  });

  it('explains an expired or replayed token rather than failing opaquely', async () => {
    // Turnstile tokens are single-use and expire after five minutes, so a
    // referrer who fills the form in slowly hits this for real.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const testApp = buildTestApp({ bindings: { TURNSTILE_SECRET_KEY: 'test-secret' } });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-turnstile-response': 'stale' },
      body: JSON.stringify(submission(world)),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('expired');
  });

  it('refuses when Cloudflare is unreachable, rather than letting it through', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 502 }));

    const testApp = buildTestApp({ bindings: { TURNSTILE_SECRET_KEY: 'test-secret' } });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-turnstile-response': 'a-token' },
      body: JSON.stringify(submission(world)),
    });

    expect(response.status).toBe(400);
    expect(await db.select().from(referrals)).toHaveLength(0);
  });

  it('is skipped when no secret is configured, so development still works', async () => {
    const testApp = buildTestApp();
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    expect((await submitReferral(testApp, world)).status).toBe(201);
  });
});

describe('CORS', () => {
  it('emits nothing when no origins are configured', async () => {
    const testApp = buildTestApp();

    const response = await testApp.request('/health', { headers: { origin: 'https://evil.test' } });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows a configured origin with credentials', async () => {
    const testApp = buildTestApp({ bindings: { ALLOWED_ORIGINS: 'https://app.foodbank.test' } });

    const response = await testApp.request('/health', {
      headers: { origin: 'https://app.foodbank.test' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.foodbank.test');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    // Without Vary, a shared cache could serve one origin's response to another.
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('never reflects an unknown origin', async () => {
    const testApp = buildTestApp({ bindings: { ALLOWED_ORIGINS: 'https://app.foodbank.test' } });

    const response = await testApp.request('/health', {
      headers: { origin: 'https://evil.test' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a preflight for an allowed origin and refuses one for an unknown origin', async () => {
    const testApp = buildTestApp({ bindings: { ALLOWED_ORIGINS: 'https://app.foodbank.test' } });

    const allowed = await testApp.request('/api/v1/public/sessions', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.foodbank.test' },
    });
    const refused = await testApp.request('/api/v1/public/sessions', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.test' },
    });

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-headers')).toContain('cf-turnstile-response');
    // The self-service edit window is gone, so its header is no longer allowed.
    expect(allowed.headers.get('access-control-allow-headers')).not.toContain('x-referral-key');
    expect(refused.status).toBe(403);
  });
});

describe('purging personal data', () => {
  async function seedOldReferral() {
    const testApp = buildTestApp({ clock: fixedClock('2026-08-04T09:00:00.000Z') });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const submitted = await submitReferral(testApp, world, {
      answers: { dietary_needs: 'no pork' },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const { id } = submitted;

    // Age it beyond any plausible retention period.
    await db
      .update(referrals)
      .set({ referredAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(referrals.id, id));

    return { testApp, id };
  }

  const deps = (retentionDays: number | undefined) => ({
    db,
    clock: fixedClock('2026-08-04T09:00:00.000Z'),
    logger: createLogger('silent'),
    retentionDays,
  });

  it('does nothing at all until a retention period is set', async () => {
    const { id } = await seedOldReferral();

    const result = await purgeReferralPii(deps(undefined));

    expect(result.purged).toBe(0);
    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(row?.refereeSurname).toBe('Wintergreen');
    expect(row?.piiPurgedAt).toBeNull();
  });

  it("removes every one of the referee's own columns once it does", async () => {
    const { id } = await seedOldReferral();

    const result = await purgeReferralPii(deps(365));

    expect(result.purged).toBe(1);
    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));

    expect(row?.refereeFirstName).toBeNull();
    expect(row?.refereeSurname).toBeNull();
    expect(row?.refereeDateOfBirth).toBeNull();
    expect(row?.refereeAddress).toBeNull();
    expect(row?.refereePostcode).toBeNull();
    expect(row?.refereePhone).toBeNull();
    // The settled forms used for repeat-referral matching, alongside the
    // values they are derived from. This matters more than it looks: without
    // it, a household the food bank has promised to forget would go on
    // matching by a postcode or phone number it says it no longer holds —
    // the repeat-referral screen would keep surfacing a household that a
    // purge was supposed to make untraceable.
    expect(row?.refereePostcodeNormalised).toBeNull();
    expect(row?.refereePhoneNormalised).toBeNull();
    expect(row?.piiPurgedAt).toEqual(expect.any(String));
  });

  it("keeps the referrer's own details, which the purge is not aimed at", async () => {
    const { id } = await seedOldReferral();

    await purgeReferralPii(deps(365));
    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));

    // The retention period exists to stop holding details of the household that
    // needed feeding, not to lose track of the professional who referred them.
    expect(row?.referrerName).toBe('Jane Fieldsworth');
    expect(row?.referrerEmail).toBe('jane@guildford.gov.uk');
    expect(row?.referrerPhone).toBe('01483 000111');
  });

  it('keeps what reporting needs, because it is no longer personal data', async () => {
    const { id } = await seedOldReferral();

    await purgeReferralPii(deps(365));
    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));

    // "We fed 340 households, 890 people, 22% for benefit delay" must survive.
    expect(row?.adults).toBe(2);
    expect(row?.children).toBe(3);
    expect(row?.reasonId).toEqual(expect.any(String));
    expect(row?.needsFuelHelp).toBe(0);
    expect(row?.referrerOrganisation).toBe('Guildford Borough Council');
    expect(row?.sessionId).toEqual(expect.any(String));
  });

  it('drops the dynamic answers whole, because nothing can classify them', async () => {
    const { id } = await seedOldReferral();

    await purgeReferralPii(deps(365));
    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));

    // The form is client configuration, so the server has no `isPii` flag to
    // consult and cannot keep a key on the grounds that it looks harmless.
    expect(row?.answersJson).toBeNull();
  });

  it('leaves a referral inside the retention period untouched', async () => {
    const testApp = buildTestApp({ clock: fixedClock('2026-08-04T09:00:00.000Z') });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);
    const { id } = await submitReferral(testApp, world);

    const result = await purgeReferralPii(deps(365));

    expect(result.purged).toBe(0);
    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(row?.refereeSurname).toBe('Wintergreen');
  });

  it('is idempotent — a second run purges nothing further', async () => {
    await seedOldReferral();

    expect((await purgeReferralPii(deps(365))).purged).toBe(1);
    expect((await purgeReferralPii(deps(365))).purged).toBe(0);
  });
});

describe('security headers', () => {
  it('are set on every response', async () => {
    const testApp = buildTestApp();

    const response = await testApp.request('/api/v1/public/sessions');

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('adds HSTS only in production', async () => {
    const dev = buildTestApp();
    const prod = buildTestApp({
      bindings: {
        ENVIRONMENT: 'production',
        AUTH_MODE: 'google',
        TURNSTILE_SECRET_KEY: 'secret',
        SMS_WEBHOOK_SECRET: 'sms-webhook-secret-long-enough',
      },
    });

    expect((await dev.request('/health')).headers.get('strict-transport-security')).toBeNull();
    expect((await prod.request('/health')).headers.get('strict-transport-security')).toContain(
      'max-age=31536000',
    );
  });
});

describe('rate limiting the open endpoints', () => {
  it('cuts off a flood of referrals from one address', async () => {
    // The limiter is 5 a minute for submissions. A real referrer submits once;
    // anything near this from a single address is a bot or a bug.
    const testApp = buildTestApp({ clientIp: '203.0.113.9' });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await submitReferral(testApp, world)).status);
    }

    expect(statuses).toContain(429);
    // Everything before the cut-off still worked, so this throttles rather
    // than breaking the endpoint.
    expect(statuses.filter((status) => status === 201).length).toBeGreaterThan(0);
  });

  it('keys on the client address, so one flooder cannot block everyone', async () => {
    const flooder = buildTestApp({ clientIp: '203.0.113.10' });
    const { accessToken } = await devLogin(flooder, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(flooder, accessToken);

    for (let i = 0; i < 8; i++) await submitReferral(flooder, world);

    // A different address, same moment, unaffected.
    const other = buildTestApp({ clientIp: '203.0.113.11' });
    expect((await submitReferral(other, world)).status).toBe(201);
  });

  it('never trusts x-forwarded-for, which a client controls', async () => {
    const testApp = buildTestApp({ clientIp: '203.0.113.12' });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpReferralWorld(testApp, accessToken);

    for (let i = 0; i < 8; i++) await submitReferral(testApp, world);

    // Spoofing a fresh forwarded-for must not reset the bucket.
    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1' },
      body: JSON.stringify(submission(world)),
    });

    expect(response.status).toBe(429);
  });
});
