import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { EXTRACT_CLAIM_TTL_MINUTES } from '../src/config/constants.ts';
import { fixedClock, type Clock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { recurringSessions, sessions, type NewSession } from '../src/db/schema/sessions.ts';
import {
  stockItems,
  stockLedger,
  type NewStockItem,
  type NewStockLedgerEntry,
} from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  setUpReferralWorld,
  submitReferral,
  UNKNOWN_REFERRER,
} from './helpers/referral-fixtures.ts';

/**
 * Exercises `src/modules/exports/*`.
 *
 * `INITIAL_SPEC1.txt`, `#Sending referrals to the spreadsheet`. The server
 * never calls Google — there is no `fetch` to stub here. It hands out
 * configuration, hands out one confirmed session at a time under an
 * expiring claim, and records that a session has been written. These tests
 * drive that machine end to end through `buildApp().request(...)` and check
 * the database directly for what a completion actually wrote.
 */

const db = createDatabase(env.DB);

const NOW = '2026-08-04T09:00:00.000Z';

const SPREADSHEET_ID = 'sheet-test-abc123';
const OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const GOOGLE_BINDINGS = {
  GOOGLE_SHEETS_SPREADSHEET_ID: SPREADSHEET_ID,
  GOOGLE_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
};

/**
 * `wrangler.jsonc`'s development `vars` already set placeholder — but
 * non-blank — values for both keys, so the "unconfigured" scenarios have to
 * override them to the empty string explicitly (`blankIsUnset` in
 * `config/env.ts` treats `''` as absent). Leaving either binding out of the
 * override would silently inherit the deployment placeholder and configure
 * the app by accident.
 */
const UNCONFIGURED_BINDINGS = { GOOGLE_SHEETS_SPREADSHEET_ID: '', GOOGLE_OAUTH_CLIENT_ID: '' };

/** An app with both deployment values set, so the extract routes are open. */
function configuredApp(clock: Clock = fixedClock(NOW)): TestApp {
  return buildTestApp({ clock, bindings: GOOGLE_BINDINGS });
}

/** An app with neither deployment value set. */
function unconfiguredApp(clock: Clock = fixedClock(NOW)): TestApp {
  return buildTestApp({ clock, bindings: UNCONFIGURED_BINDINGS });
}

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

/**
 * Referral submission is rate limited per client address, and several tests
 * here seed more than one. A counter rather than a random or shared address:
 * two referrals in the same test colliding on one would fail for a reason
 * that has nothing to do with the extract.
 */
let clientIpCounter = 0;
function nextClientIp(): string {
  clientIpCounter += 1;
  return `203.0.113.${String(clientIpCounter)}`;
}

/**
 * A confirmed session, seeded directly rather than through the pick-list and
 * attendance machinery — the extract does not care how a session became
 * confirmed, only that it is. Confirmed by default, since that is the
 * ordinary case every test but the "not offered" one wants.
 */
async function seedSession(overrides: Partial<NewSession> = {}): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  const sessionDate = overrides.sessionDate ?? '2026-08-04';
  const defaults: NewSession = {
    id,
    recurringSessionId: null,
    occurrenceDate: null,
    sessionDate,
    startTime: '10:00',
    startsAtUtc: `${sessionDate}T09:00:00.000Z`,
    durationMinutes: 120,
    location: 'Church Hall',
    capacity: 25,
    deliveryWindowStart: null,
    deliveryWindowEnd: null,
    deliveryCapacity: 25,
    status: 'confirmed',
    cancelledReason: null,
    isCustomised: 0,
    generatedAt: null,
    confirmedAt: NOW,
    confirmedByUserId: null,
    extractedAt: null,
    extractClaimId: null,
    extractClaimedByUserId: null,
    extractClaimExpiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await db.insert(sessions).values({ ...defaults, ...overrides, id });
  return id;
}

/**
 * A stock item, seeded directly rather than through the maintenance screen —
 * these tests only care that the item exists and can be joined by
 * `sumIssuedByItemForSession`, not how it was created. `name` is the caller's
 * to choose since `nameNormalised` is unique: two calls with the same default
 * name in one test would collide.
 */
async function seedStockItem(name: string, overrides: Partial<NewStockItem> = {}): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  const defaults: NewStockItem = {
    id,
    name,
    nameNormalised: name.toLowerCase(),
    shelfNumber: 'A1',
    createdAt: NOW,
    updatedAt: NOW,
  };
  await db.insert(stockItems).values({ ...defaults, ...overrides, id });
  return id;
}

/**
 * A single stock-ledger row, seeded directly. Defaults to a `parcel_issued`
 * movement with a fresh parcel id — the ordinary case every stock-usage test
 * but the "wrong movement type" ones wants. `stockItemId` and `sessionId` are
 * always the caller's to supply.
 */
async function insertLedgerRow(
  overrides: Partial<NewStockLedgerEntry> & { stockItemId: string; sessionId: string | null },
): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  const defaults: NewStockLedgerEntry = {
    id,
    stockItemId: overrides.stockItemId,
    quantityDelta: -1,
    movementType: 'parcel_issued',
    parcelId: crypto.randomUUID(),
    sessionId: overrides.sessionId,
    actorUserId: null,
    occurredAt: NOW,
    createdAt: NOW,
  };
  await db.insert(stockLedger).values({ ...defaults, ...overrides, id });
  return id;
}

interface ExtractProgressBody {
  readonly remaining: number;
  readonly extracted: number;
}

interface ExtractRowBody {
  readonly referralId: string;
  readonly status: string;
  readonly referredAt: string;
  readonly referrerOrganisation: string;
  readonly referrerName: string | null;
  readonly referrerEmail: string | null;
  readonly referrerPhone: string | null;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereeDateOfBirth: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly adults: number;
  readonly children: number;
  readonly isDelivery: boolean;
  readonly needsFuelHelp: boolean;
  readonly reason: string | null;
  readonly reviewComment: string | null;
  readonly answers: Record<string, unknown>;
}

interface StockItemUsageBody {
  readonly stockItemId: string;
  readonly stockItemName: string;
  readonly quantity: number;
}

interface ExtractClaimBody {
  readonly claimId: string;
  readonly expiresAt: string;
  readonly sessionId: string;
  readonly sessionDate: string;
  readonly sessionLocation: string;
  readonly rows: ExtractRowBody[];
  readonly stockItemUsage: StockItemUsageBody[];
}

interface ClaimResponseBody extends ExtractProgressBody {
  readonly claim: ExtractClaimBody | null;
}

interface CompleteResponseBody extends ExtractProgressBody {
  readonly sessionId: string;
  readonly extractedAt: string;
  readonly alreadyExtracted: boolean;
}

async function getConfig(
  testApp: TestApp,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request('/api/v1/extracts/config', {
    headers: authHeaders(token),
  });
  const body: Record<string, unknown> = await response.json();
  return { status: response.status, body };
}

async function getProgress(
  testApp: TestApp,
  token: string,
): Promise<{ status: number; body: ExtractProgressBody }> {
  const response = await testApp.request('/api/v1/extracts', { headers: authHeaders(token) });
  const body: ExtractProgressBody = await response.json();
  return { status: response.status, body };
}

async function claimNext(
  testApp: TestApp,
  token: string,
): Promise<{ status: number; body: ClaimResponseBody }> {
  const response = await testApp.request('/api/v1/extracts/claims', {
    method: 'POST',
    headers: authHeaders(token),
  });
  const body: ClaimResponseBody = await response.json();
  return { status: response.status, body };
}

async function completeClaim(
  testApp: TestApp,
  token: string,
  claimId: string,
): Promise<{ status: number; body: CompleteResponseBody }> {
  const response = await testApp.request(`/api/v1/extracts/claims/${claimId}/complete`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  const body: CompleteResponseBody = await response.json();
  return { status: response.status, body };
}

async function sessionRow(sessionId: string) {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  return row;
}

beforeEach(async () => {
  // `stockLedger` references both `stockItems` and `sessions`, so it must be
  // cleared before either — see the same ordering in `attendance.test.ts`.
  await db.delete(stockLedger);
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

describe('the spreadsheet extract', () => {
  describe('roles', () => {
    it('is admin only on every route: unauthenticated is refused, team_lead and fuel_admin are forbidden, admin gets through', async () => {
      const testApp = configuredApp();
      const { accessToken: adminToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const { accessToken: leadToken } = await devLogin(testApp, {
        email: 'lead@foodbank.org',
        role: 'team_lead',
      });
      const { accessToken: fuelToken } = await devLogin(testApp, {
        email: 'fuel@foodbank.org',
        role: 'fuel_admin',
      });

      const routes: { method: 'GET' | 'POST'; path: string; adminStatus: number }[] = [
        { method: 'GET', path: '/api/v1/extracts/config', adminStatus: 200 },
        { method: 'GET', path: '/api/v1/extracts', adminStatus: 200 },
        { method: 'POST', path: '/api/v1/extracts/claims', adminStatus: 200 },
        // Config is set but the claim id is unknown, so a role that gets
        // through the guard still reaches the service and gets 404 — proof
        // it was not stopped by the role check, unlike the other two roles.
        {
          method: 'POST',
          path: `/api/v1/extracts/claims/${crypto.randomUUID()}/complete`,
          adminStatus: 404,
        },
      ];

      for (const route of routes) {
        const unauthenticated = await testApp.request(route.path, { method: route.method });
        expect(unauthenticated.status, `${route.method} ${route.path} unauthenticated`).toBe(401);

        const lead = await testApp.request(route.path, {
          method: route.method,
          headers: authHeaders(leadToken),
        });
        expect(lead.status, `${route.method} ${route.path} team_lead`).toBe(403);

        const fuel = await testApp.request(route.path, {
          method: route.method,
          headers: authHeaders(fuelToken),
        });
        expect(fuel.status, `${route.method} ${route.path} fuel_admin`).toBe(403);

        const admin = await testApp.request(route.path, {
          method: route.method,
          headers: authHeaders(adminToken),
        });
        expect(admin.status, `${route.method} ${route.path} admin`).toBe(route.adminStatus);
      }
    });
  });

  describe('configuration', () => {
    it('reports configured true with both the spreadsheet id and the Google OAuth client id set', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });

      const { status, body } = await getConfig(testApp, token);

      expect(status).toBe(200);
      expect(body).toEqual({
        configured: true,
        spreadsheetId: SPREADSHEET_ID,
        googleClientId: OAUTH_CLIENT_ID,
      });
    });

    it('reports configured false and omits both fields entirely when neither value is set', async () => {
      const testApp = unconfiguredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });

      const { status, body } = await getConfig(testApp, token);

      expect(status).toBe(200);
      expect(body).toEqual({ configured: false });
      // The keys must be entirely absent, not present and undefined — that is
      // what proves the response mapper never widens rather than merely
      // happening to serialise `undefined` away.
      expect(Object.prototype.hasOwnProperty.call(body, 'spreadsheetId')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(body, 'googleClientId')).toBe(false);
    });

    it('treats a spreadsheet id with no OAuth client id as not configured — all-or-nothing', async () => {
      const testApp = buildTestApp({
        clock: fixedClock(NOW),
        bindings: { GOOGLE_SHEETS_SPREADSHEET_ID: SPREADSHEET_ID, GOOGLE_OAUTH_CLIENT_ID: '' },
      });
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });

      const { body } = await getConfig(testApp, token);

      expect(body).toEqual({ configured: false });
    });

    it('refuses to start a claim when the extract is not configured', async () => {
      const testApp = unconfiguredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });

      const response = await testApp.request('/api/v1/extracts/claims', {
        method: 'POST',
        headers: authHeaders(token),
      });

      expect(response.status).toBe(422);
    });

    it('refuses to complete a claim when the extract is not configured', async () => {
      const testApp = unconfiguredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });

      const response = await testApp.request(
        `/api/v1/extracts/claims/${crypto.randomUUID()}/complete`,
        { method: 'POST', headers: authHeaders(token) },
      );

      expect(response.status).toBe(422);
    });
  });

  describe('claiming', () => {
    it('claims the oldest confirmed session first, and the response carries the claim id, expiry, session id, date and rows', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });

      await seedSession({ sessionDate: '2026-08-03' });
      const earliest = await seedSession({ sessionDate: '2026-08-01' });
      await seedSession({ sessionDate: '2026-08-02' });

      const { status, body } = await claimNext(testApp, token);

      expect(status).toBe(200);
      expect(body.claim?.sessionId).toBe(earliest);
      expect(body.claim?.sessionDate).toBe('2026-08-01');
      expect(Object.keys(body.claim ?? {}).sort()).toEqual(
        [
          'claimId',
          'expiresAt',
          'sessionId',
          'sessionDate',
          'sessionLocation',
          'rows',
          'stockItemUsage',
        ].sort(),
      );
      expect(typeof body.claim?.claimId).toBe('string');
      expect(body.claim?.claimId.length).toBeGreaterThan(0);
      expect(body.claim?.rows).toEqual([]);
    });

    it('carries stockItemUsage: [] — present, not omitted — for a confirmed session that issued no stock at all', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      await seedSession({ sessionDate: '2026-08-01' });

      const { status, body } = await claimNext(testApp, token);

      expect(status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body.claim ?? {}, 'stockItemUsage')).toBe(true);
      expect(body.claim?.stockItemUsage).toEqual([]);
    });

    it('carries the session location, not its id, so the spreadsheet gets a place rather than a UUID', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });

      const sessionId = await seedSession({
        sessionDate: '2026-08-01',
        location: "St Mary's Hall",
      });

      const { status, body } = await claimNext(testApp, token);

      expect(status).toBe(200);
      expect(body.claim?.sessionId).toBe(sessionId);
      expect(body.claim?.sessionLocation).toBe("St Mary's Hall");
      expect(body.claim?.sessionLocation).not.toBe(body.claim?.sessionId);
    });

    it('never claims a planned, in-progress or cancelled session, and does not count them in remaining', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });

      await seedSession({ status: 'planned', sessionDate: '2026-08-01' });
      await seedSession({ status: 'in_progress', sessionDate: '2026-08-02' });
      await seedSession({ status: 'cancelled', sessionDate: '2026-08-03' });
      const confirmed = await seedSession({ status: 'confirmed', sessionDate: '2026-08-04' });

      const progress = await getProgress(testApp, token);
      expect(progress.body).toEqual({ remaining: 1, extracted: 0 });

      const first = await claimNext(testApp, token);
      expect(first.body.claim?.sessionId).toBe(confirmed);

      // Nothing else confirmed is left, so a second claim finds nothing —
      // positive control that the three excluded sessions really were never
      // offered rather than merely offered second.
      const second = await claimNext(testApp, token);
      expect(second.body.claim).toBeNull();
    });

    it('never selects an already-extracted session', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      await seedSession({ sessionDate: '2026-08-01', extractedAt: NOW });

      const { status, body } = await claimNext(testApp, token);

      expect(status).toBe(200);
      expect(body.claim).toBeNull();
    });

    it('returns claim: null with a 200, not an error, when nothing confirmed is waiting', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });

      const { status, body } = await claimNext(testApp, token);

      expect(status).toBe(200);
      expect(body.claim).toBeNull();
    });

    it('carries every referral on the session, whatever its status — active, reviewed, pending_review, rejected and cancelled alike', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const world = await setUpReferralWorld(testApp, token);

      const active = await submitReferral(testApp, world, {}, { clientIp: nextClientIp() });

      const toReview = await submitReferral(testApp, world, {}, { clientIp: nextClientIp() });
      const reviewed = await testApp.request(`/api/v1/referrals/${toReview.id}/review`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      expect(reviewed.status).toBe(200);

      const pending = await submitReferral(testApp, world, UNKNOWN_REFERRER, {
        clientIp: nextClientIp(),
      });

      const toReject = await submitReferral(testApp, world, UNKNOWN_REFERRER, {
        clientIp: nextClientIp(),
      });
      const rejected = await testApp.request(`/api/v1/referrals/${toReject.id}/reject`, {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ comment: 'Suspected duplicate' }),
      });
      expect(rejected.status).toBe(200);

      const toCancel = await submitReferral(testApp, world, {}, { clientIp: nextClientIp() });
      const cancelled = await testApp.request(`/api/v1/referrals/${toCancel.id}/cancel`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      expect(cancelled.status).toBe(200);

      // Signed off directly: the export does not care how a session reached
      // 'confirmed', only that it did.
      await db
        .update(sessions)
        .set({ status: 'confirmed', confirmedAt: NOW, updatedAt: NOW })
        .where(eq(sessions.id, world.sessionId));

      const { status, body } = await claimNext(testApp, token);
      expect(status).toBe(200);

      const rows = body.claim?.rows ?? [];
      const byId = new Map(rows.map((row) => [row.referralId, row]));

      expect(byId.get(active.id)?.status).toBe('active');
      expect(byId.get(toReview.id)?.status).toBe('reviewed');
      expect(byId.get(pending.id)?.status).toBe('pending_review');
      expect(byId.get(toReject.id)?.status).toBe('rejected');
      expect(byId.get(toCancel.id)?.status).toBe('cancelled');
      expect(rows).toHaveLength(5);

      // The administrator's comment travels with the rejected row — it is
      // part of what the charity decided should reach the spreadsheet.
      expect(byId.get(toReject.id)?.reviewComment).toBe('Suspected duplicate');
    });
  });

  describe('the claim is exclusive', () => {
    it('does not hand out a session that is already claimed and still within its TTL — the second claim goes to a different session, and the first is still completable', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const first = await seedSession({ sessionDate: '2026-08-01' });
      const second = await seedSession({ sessionDate: '2026-08-02' });

      const claim1 = await claimNext(testApp, token);
      expect(claim1.body.claim?.sessionId).toBe(first);

      const claim2 = await claimNext(testApp, token);
      expect(claim2.body.claim?.sessionId).toBe(second);
      expect(claim2.body.claim?.sessionId).not.toBe(claim1.body.claim?.sessionId);

      // Proof the first claim was never touched by the second call: it still
      // completes successfully, against the session it was actually issued
      // for.
      const claimId = claim1.body.claim?.claimId;
      if (claimId === undefined) throw new Error('expected a claim');
      const completed = await completeClaim(testApp, token, claimId);
      expect(completed.status).toBe(200);
      expect(completed.body.sessionId).toBe(first);
      expect(completed.body.alreadyExtracted).toBe(false);
    });
  });

  /**
   * `INITIAL_SPEC1.txt`, `#Sending referrals to the spreadsheet`: "A batch
   * running out of sessions to hand out is not the same thing as the work
   * being finished, and the administrator is never told the one when the
   * other is true."
   *
   * A browser whose Google write fails stops without completing, and a
   * reservation is given back only by expiring. So the session it held is
   * skipped by the next claim, and once everything unextracted is reserved
   * the queue hands out nothing at all — while every one of those sessions is
   * still outstanding. `remaining` is the only thing separating that from a
   * finished batch, which is why the contract leans on it so hard.
   *
   * Nothing is lost here and nothing is sent twice; the danger is a screen
   * reading `claim: null` as "the spreadsheet is up to date", after which
   * nobody has any reason to look again.
   */
  describe('a failed write leaves its session reserved, and a null claim is not "done"', () => {
    it('does not mark the session extracted when the browser never completes', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });

      const claimed = await claimNext(testApp, token);
      expect(claimed.body.claim?.sessionId).toBe(sessionId);

      // The Google write fails. The browser stops. No completion call.
      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));

      expect(row?.extractedAt).toBeNull();
      // But the reservation the claim wrote is still on the row — that write
      // is what makes the claim exclusive, and it is not undone by failure.
      expect(row?.extractClaimId).not.toBeNull();
      expect(claimed.body.remaining).toBe(1);
      expect(claimed.body.extracted).toBe(0);
    });

    it('skips the reserved session on the next claim and hands out the one below it', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const first = await seedSession({ sessionDate: '2026-08-01' });
      const second = await seedSession({ sessionDate: '2026-08-02' });

      const failed = await claimNext(testApp, token);
      expect(failed.body.claim?.sessionId).toBe(first);

      // The administrator presses extract again straight away.
      const retry = await claimNext(testApp, token);
      expect(retry.body.claim?.sessionId).toBe(second);
    });

    it('returns claim: null with remaining still counting every reserved session — the exact shape a screen must not call "complete"', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      await seedSession({ sessionDate: '2026-08-01' });
      await seedSession({ sessionDate: '2026-08-02' });

      await claimNext(testApp, token);
      await claimNext(testApp, token);

      const exhausted = await claimNext(testApp, token);

      expect(exhausted.status).toBe(200);
      expect(exhausted.body.claim).toBeNull();
      // Two sessions reserved, none written. A null claim beside a non-zero
      // `remaining` is "the rest are reserved", never "finished".
      expect(exhausted.body.remaining).toBe(2);
      expect(exhausted.body.extracted).toBe(0);
    });
  });

  describe('expiry and recovery', () => {
    const T0 = '2026-08-04T09:00:00.000Z';
    // Just past the 10-minute TTL.
    const AFTER_TTL = '2026-08-04T09:11:00.000Z';
    // Well within it, so a second administrator's own attempt is not itself
    // excused by having arrived too late.
    const WITHIN_TTL = '2026-08-04T09:05:00.000Z';

    it('sets the claim to expire exactly EXTRACT_CLAIM_TTL_MINUTES (10) after the claim, so changing the constant is a visible test change', async () => {
      const testApp = configuredApp(fixedClock(T0));
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      await seedSession({ sessionDate: '2026-08-01' });

      expect(EXTRACT_CLAIM_TTL_MINUTES).toBe(10);

      const { body } = await claimNext(testApp, token);

      // Computed by hand, independently of the code under test.
      expect(body.claim?.expiresAt).toBe('2026-08-04T09:10:00.000Z');
    });

    it('makes an expired claim claimable again by a later call', async () => {
      const testApp = configuredApp(fixedClock(T0));
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });

      const first = await claimNext(testApp, token);
      expect(first.body.claim?.sessionId).toBe(sessionId);
      const firstClaimId = first.body.claim?.claimId;

      // A later app instance sharing the same database — the pattern used
      // throughout this suite to advance time, since `vi.useFakeTimers()`
      // does not work here. The access token issued at T0 is still valid at
      // T0+11 minutes (its own TTL is 15 minutes), so no re-login is needed.
      const later = configuredApp(fixedClock(AFTER_TTL));
      const second = await claimNext(later, token);

      expect(second.body.claim?.sessionId).toBe(sessionId);
      expect(second.body.claim?.claimId).not.toBe(firstClaimId);
    });

    it('refuses to complete an expired claim, says so, and does not mark the session extracted', async () => {
      const testApp = configuredApp(fixedClock(T0));
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });

      const claimed = await claimNext(testApp, token);
      const claimId = claimed.body.claim?.claimId;
      if (claimId === undefined) throw new Error('expected a claim');

      const later = configuredApp(fixedClock(AFTER_TTL));
      const response = await later.request(`/api/v1/extracts/claims/${claimId}/complete`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const body: { error: { message: string } } = await response.json();

      expect(response.status).toBe(409);
      expect(body.error.message.toLowerCase()).toContain('expired');

      const row = await sessionRow(sessionId);
      expect(row?.extractedAt).toBeNull();
    });

    it("refuses to complete another administrator's live claim, says so, and does not mark the session extracted", async () => {
      const testApp = configuredApp(fixedClock(T0));
      const { accessToken: tokenA } = await devLogin(testApp, { email: 'admin-a@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });

      const claimed = await claimNext(testApp, tokenA);
      const claimId = claimed.body.claim?.claimId;
      if (claimId === undefined) throw new Error('expected a claim');

      // Still well inside the TTL — this is a conflict between two
      // administrators, not a recovery from expiry.
      const otherApp = configuredApp(fixedClock(WITHIN_TTL));
      const { accessToken: tokenB } = await devLogin(otherApp, { email: 'admin-b@foodbank.org' });

      const response = await otherApp.request(`/api/v1/extracts/claims/${claimId}/complete`, {
        method: 'POST',
        headers: authHeaders(tokenB),
      });
      const body: { error: { message: string } } = await response.json();

      expect(response.status).toBe(409);
      expect(body.error.message.toLowerCase()).toContain('another administrator');

      const row = await sessionRow(sessionId);
      expect(row?.extractedAt).toBeNull();
    });

    it('returns 404 for a claim id this server never issued', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });

      const response = await completeClaim(testApp, token, crypto.randomUUID());

      expect(response.status).toBe(404);
    });
  });

  describe('completion', () => {
    it('completes a live claim: 200, alreadyExtracted false, and the session is stamped extracted in the database', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });

      const claimed = await claimNext(testApp, token);
      const claimId = claimed.body.claim?.claimId;
      if (claimId === undefined) throw new Error('expected a claim');

      const { status, body } = await completeClaim(testApp, token, claimId);

      expect(status).toBe(200);
      expect(body.sessionId).toBe(sessionId);
      expect(body.alreadyExtracted).toBe(false);

      const row = await sessionRow(sessionId);
      expect(row?.extractedAt).toBe(body.extractedAt);
    });

    it('is safe to retry: completing the same claim twice reports alreadyExtracted the second time, with the same extractedAt, and changes nothing', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });

      const claimed = await claimNext(testApp, token);
      const claimId = claimed.body.claim?.claimId;
      if (claimId === undefined) throw new Error('expected a claim');

      const first = await completeClaim(testApp, token, claimId);
      expect(first.status).toBe(200);
      expect(first.body.alreadyExtracted).toBe(false);

      const rowAfterFirst = await sessionRow(sessionId);

      const second = await completeClaim(testApp, token, claimId);

      expect(second.status).toBe(200);
      expect(second.body.alreadyExtracted).toBe(true);
      expect(second.body.extractedAt).toBe(first.body.extractedAt);
      expect(second.body.sessionId).toBe(sessionId);

      const rowAfterSecond = await sessionRow(sessionId);
      expect(rowAfterSecond?.extractedAt).toBe(rowAfterFirst?.extractedAt);
      expect(rowAfterSecond?.updatedAt).toBe(rowAfterFirst?.updatedAt);
    });

    it('moves remaining down and extracted up by exactly one on completion', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      await seedSession({ sessionDate: '2026-08-01' });
      await seedSession({ sessionDate: '2026-08-02' });

      const before = await getProgress(testApp, token);
      expect(before.body).toEqual({ remaining: 2, extracted: 0 });

      const claimed = await claimNext(testApp, token);
      const claimId = claimed.body.claim?.claimId;
      if (claimId === undefined) throw new Error('expected a claim');

      const { body: completedBody } = await completeClaim(testApp, token, claimId);
      expect(completedBody).toMatchObject({ remaining: 1, extracted: 1 });

      const after = await getProgress(testApp, token);
      expect(after.body).toEqual({ remaining: 1, extracted: 1 });
    });
  });

  describe('the row shape', () => {
    it('carries exactly the agreed fields, with answers as an object, isDelivery/needsFuelHelp as booleans, reason as the label (including a retired one), and reviewComment present', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const world = await setUpReferralWorld(testApp, token, { deliveryCapacity: 5 });

      const reasonResponse = await testApp.request('/api/v1/referral-reasons', {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ code: 'housing_crisis', label: 'Housing crisis' }),
      });
      expect(reasonResponse.status).toBe(201);
      const { id: reasonId }: { id: string } = await reasonResponse.json();

      // Held for review so the accept comment lands on `reviewComment`.
      const submitted = await submitReferral(
        testApp,
        world,
        { ...UNKNOWN_REFERRER, reasonId, collectionMethod: 'delivery', needsFuelHelp: true },
        { clientIp: nextClientIp() },
      );
      expect(submitted.referralStatus).toBe('pending_review');

      const accepted = await testApp.request(`/api/v1/referrals/${submitted.id}/accept`, {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ comment: 'Approved by phone' }),
      });
      expect(accepted.status).toBe(200);

      // Retired after the referral cited it — a referral that cited a reason
      // keeps it, and the row must still resolve its label.
      const retired = await testApp.request(`/api/v1/referral-reasons/${reasonId}`, {
        method: 'PATCH',
        headers: json(token),
        body: JSON.stringify({ isActive: false }),
      });
      expect(retired.status).toBe(200);

      await db
        .update(sessions)
        .set({ status: 'confirmed', confirmedAt: NOW, updatedAt: NOW })
        .where(eq(sessions.id, world.sessionId));

      const { status, body } = await claimNext(testApp, token);
      expect(status).toBe(200);

      const row = body.claim?.rows.find((candidate) => candidate.referralId === submitted.id);
      expect(row).toBeDefined();
      if (row === undefined) throw new Error('expected a row');

      expect(Object.keys(row).sort()).toEqual(
        [
          'referralId',
          'status',
          'referredAt',
          'referrerOrganisation',
          'referrerName',
          'referrerEmail',
          'referrerPhone',
          'refereeFirstName',
          'refereeSurname',
          'refereeDateOfBirth',
          'refereeAddress',
          'refereePostcode',
          'refereePhone',
          'adults',
          'children',
          'isDelivery',
          'needsFuelHelp',
          'reason',
          'reviewComment',
          'answers',
        ].sort(),
      );

      expect(row.status).toBe('active');
      expect(row.reason).toBe('Housing crisis');
      expect(row.reason).not.toBe(reasonId);
      expect(row.reviewComment).toBe('Approved by phone');
      expect(row.isDelivery).toBe(true);
      expect(row.needsFuelHelp).toBe(true);
      expect(typeof row.isDelivery).toBe('boolean');
      expect(typeof row.needsFuelHelp).toBe('boolean');

      // `answers` is an object, not the raw JSON string column.
      expect(typeof row.answers).toBe('object');
      expect(Array.isArray(row.answers)).toBe(false);
      expect(row.answers).toEqual({ Dietary: 'no pork' });

      // Scoped to the row alone, not the whole response — `claim.sessionId`
      // legitimately appears one level up, and the point here is that it is
      // not duplicated inside the row itself.
      const rowText = JSON.stringify(row);
      for (const absent of [
        'answersJson',
        'refereePostcodeNormalised',
        'refereePhoneNormalised',
        'reasonId',
        'sessionId',
        'authorisedReferrerId',
        'reviewedByUserId',
        'cancelledReason',
        'piiPurgedAt',
      ]) {
        expect(rowText).not.toContain(absent);
      }
    });
  });

  describe('stock item usage', () => {
    it('sums parcel_issued quantity across every parcel on the session for one item, reported as a positive whole number', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });
      const beansId = await seedStockItem('Baked Beans');

      // Two parcels, each issuing beans, each its own ledger row.
      await insertLedgerRow({ stockItemId: beansId, sessionId, quantityDelta: -3 });
      await insertLedgerRow({ stockItemId: beansId, sessionId, quantityDelta: -2 });

      const { status, body } = await claimNext(testApp, token);

      expect(status).toBe(200);
      expect(body.claim?.stockItemUsage).toEqual([
        { stockItemId: beansId, stockItemName: 'Baked Beans', quantity: 5 },
      ]);
    });

    it('never counts an opening_balance or correction movement, even one that carries this session id', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });
      const beansId = await seedStockItem('Baked Beans');

      // Real code never stamps a session id on these movement types, but the
      // query must filter on `movementType` itself rather than incidentally
      // relying on that — so these deliberately carry the test session's id.
      await insertLedgerRow({
        stockItemId: beansId,
        sessionId,
        movementType: 'opening_balance',
        quantityDelta: 50,
        parcelId: null,
      });
      await insertLedgerRow({
        stockItemId: beansId,
        sessionId,
        movementType: 'correction',
        quantityDelta: -10,
        parcelId: null,
      });
      await insertLedgerRow({ stockItemId: beansId, sessionId, quantityDelta: -4 });

      const { body } = await claimNext(testApp, token);

      expect(body.claim?.stockItemUsage).toEqual([
        { stockItemId: beansId, stockItemName: 'Baked Beans', quantity: 4 },
      ]);
    });

    it("never lets a parcel_issued movement for a different session leak into this session's usage", async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });
      const otherSessionId = await seedSession({ sessionDate: '2026-08-02' });
      const beansId = await seedStockItem('Baked Beans');

      await insertLedgerRow({ stockItemId: beansId, sessionId: otherSessionId, quantityDelta: -5 });

      const { body } = await claimNext(testApp, token);

      expect(body.claim?.sessionId).toBe(sessionId);
      expect(body.claim?.stockItemUsage).toEqual([]);
    });

    it('omits an item entirely when it was never issued for the session, rather than listing it at quantity zero', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });
      const issued = await seedStockItem('Baked Beans');
      const neverIssued = await seedStockItem('Tinned Soup');

      await insertLedgerRow({ stockItemId: issued, sessionId, quantityDelta: -1 });

      const { body } = await claimNext(testApp, token);

      const ids = (body.claim?.stockItemUsage ?? []).map((usage) => usage.stockItemId);
      expect(ids).toContain(issued);
      expect(ids).not.toContain(neverIssued);
    });

    it('omits an item whose net summed quantity is zero or negative — provable only by directly inserting conflicting ledger rows', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });
      const netZero = await seedStockItem('Net Zero Item');
      const netNegative = await seedStockItem('Net Negative Item');
      const genuinelyIssued = await seedStockItem('Baked Beans');

      // Real code never writes a positive `parcel_issued` delta; these
      // conflicting rows exist only to prove the response-side filter, not to
      // model anything the ledger would actually contain.
      await insertLedgerRow({ stockItemId: netZero, sessionId, quantityDelta: -3 });
      await insertLedgerRow({ stockItemId: netZero, sessionId, quantityDelta: 3 });

      await insertLedgerRow({ stockItemId: netNegative, sessionId, quantityDelta: -2 });
      await insertLedgerRow({ stockItemId: netNegative, sessionId, quantityDelta: 5 });

      await insertLedgerRow({ stockItemId: genuinelyIssued, sessionId, quantityDelta: -1 });

      const { body } = await claimNext(testApp, token);

      const ids = (body.claim?.stockItemUsage ?? []).map((usage) => usage.stockItemId);
      expect(ids).not.toContain(netZero);
      expect(ids).not.toContain(netNegative);
      expect(ids).toContain(genuinelyIssued);
    });

    it('still lists a retired stock item, with its name, if it was issued for the session', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });
      const retiredId = await seedStockItem('Discontinued Soup', { isActive: 0 });

      await insertLedgerRow({ stockItemId: retiredId, sessionId, quantityDelta: -6 });

      const { body } = await claimNext(testApp, token);

      expect(body.claim?.stockItemUsage).toEqual([
        { stockItemId: retiredId, stockItemName: 'Discontinued Soup', quantity: 6 },
      ]);
    });

    it('exposes only stockItemId, stockItemName and quantity — no ledger row id, parcel id, movement type or actor leak through', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });
      const beansId = await seedStockItem('Baked Beans');
      const actorId = crypto.randomUUID();
      await db.insert(users).values({
        id: actorId,
        email: 'volunteer@foodbank.org',
        displayName: 'A Volunteer',
        role: 'team_lead',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const parcelId = crypto.randomUUID();
      const ledgerRowId = crypto.randomUUID();
      await insertLedgerRow({
        id: ledgerRowId,
        stockItemId: beansId,
        sessionId,
        quantityDelta: -1,
        parcelId,
        actorUserId: actorId,
      });

      const { body } = await claimNext(testApp, token);

      const usage = body.claim?.stockItemUsage ?? [];
      expect(usage).toHaveLength(1);
      expect(Object.keys(usage[0] ?? {}).sort()).toEqual(
        ['stockItemId', 'stockItemName', 'quantity'].sort(),
      );

      const usageText = JSON.stringify(usage);
      for (const absent of [ledgerRowId, parcelId, actorId, 'parcel_issued', 'movementType']) {
        expect(usageText).not.toContain(absent);
      }
    });
  });

  describe('completing a claim never touches the stock ledger or stock items — it stamps the session only', () => {
    it('leaves every stock_ledger row for the session byte-identical, and stock_items untouched, after completion', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
      const sessionId = await seedSession({ sessionDate: '2026-08-01' });
      const beansId = await seedStockItem('Baked Beans');
      await insertLedgerRow({ stockItemId: beansId, sessionId, quantityDelta: -4 });

      const claimed = await claimNext(testApp, token);
      const claimId = claimed.body.claim?.claimId;
      if (claimId === undefined) throw new Error('expected a claim');
      expect(claimed.body.claim?.stockItemUsage).toEqual([
        { stockItemId: beansId, stockItemName: 'Baked Beans', quantity: 4 },
      ]);

      const ledgerBefore = await db
        .select()
        .from(stockLedger)
        .where(eq(stockLedger.sessionId, sessionId));
      const itemsBefore = await db.select().from(stockItems).where(eq(stockItems.id, beansId));

      const { status, body } = await completeClaim(testApp, token, claimId);
      expect(status).toBe(200);
      expect(body.sessionId).toBe(sessionId);

      const row = await sessionRow(sessionId);
      expect(row?.extractedAt).not.toBeNull();

      const ledgerAfter = await db
        .select()
        .from(stockLedger)
        .where(eq(stockLedger.sessionId, sessionId));
      const itemsAfter = await db.select().from(stockItems).where(eq(stockItems.id, beansId));

      expect(ledgerAfter).toEqual(ledgerBefore);
      expect(itemsAfter).toEqual(itemsBefore);
    });
  });

  describe('progress', () => {
    it('counts confirmed sessions only', async () => {
      const testApp = configuredApp();
      const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });

      await seedSession({ status: 'planned', sessionDate: '2026-08-01' });
      await seedSession({ status: 'in_progress', sessionDate: '2026-08-02' });
      await seedSession({ status: 'cancelled', sessionDate: '2026-08-03' });
      await seedSession({ status: 'confirmed', sessionDate: '2026-08-04' });
      await seedSession({ status: 'confirmed', sessionDate: '2026-08-05', extractedAt: NOW });

      const { status, body } = await getProgress(testApp, token);

      expect(status).toBe(200);
      expect(body).toEqual({ remaining: 1, extracted: 1 });
    });

    it('includes a session another administrator currently holds a live claim on — it is outstanding work, just not theirs', async () => {
      const testApp = configuredApp();
      const { accessToken: tokenA } = await devLogin(testApp, { email: 'admin-a@foodbank.org' });
      const { accessToken: tokenB } = await devLogin(testApp, { email: 'admin-b@foodbank.org' });

      await seedSession({ sessionDate: '2026-08-01' });

      const claimed = await claimNext(testApp, tokenA);
      expect(claimed.body.claim).not.toBeNull();

      const { body } = await getProgress(testApp, tokenB);
      expect(body).toEqual({ remaining: 1, extracted: 0 });
    });
  });
});
