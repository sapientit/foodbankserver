import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  setUpReferralWorld,
  submitReferral,
  UNKNOWN_REFERRER,
  type ReferralWorld,
} from './helpers/referral-fixtures.ts';

const db = createDatabase(env.DB);

// Chosen clear of the BST changeover, so the thirty-day cutoff is a plain
// UTC-minute subtraction — both ends are GMT in London, which is exactly the
// arithmetic `referralListStaleCutoff` does on the London calendar.
const NOW = '2026-02-10T09:00:00.000Z';
const STALE_CUTOFF = '2026-01-11T09:00:00.000Z'; // exactly thirty days back: inclusive
const JUST_OUTSIDE_CUTOFF = '2026-01-11T08:59:00.000Z'; // one minute earlier: excluded

/**
 * Referral submission is rate limited per client address, and several tests
 * here submit many in one test.
 */
let clientIpCounter = 0;
function nextClientIp(): string {
  clientIpCounter += 1;
  return `203.0.113.${String(clientIpCounter)}`;
}

async function world(
  options: { capacity?: number } = {},
): Promise<{ testApp: TestApp; token: string; world: ReferralWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const built = await setUpReferralWorld(testApp, accessToken, options);
  return { testApp, token: accessToken, world: built };
}

async function setReferredAt(id: string, referredAt: string): Promise<void> {
  await db.update(referrals).set({ referredAt }).where(eq(referrals.id, id));
}

async function review(testApp: TestApp, token: string, id: string): Promise<void> {
  const response = await testApp.request(`/api/v1/referrals/${id}/review`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
}

interface CheckPage {
  readonly referrals: { id: string; status: string }[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;
}

/** `GET /referrals/check` — the paginated "Check referrals" screen. */
async function checkReferrals(testApp: TestApp, token: string, query = ''): Promise<CheckPage> {
  const response = await testApp.request(`/api/v1/referrals/check${query}`, {
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
  return response.json();
}

/** `GET /referrals` — the plain, unbounded list running a session relies on. */
async function listReferrals(
  testApp: TestApp,
  token: string,
  query = '',
): Promise<{ referrals: { id: string; status: string }[] }> {
  const response = await testApp.request(`/api/v1/referrals${query}`, {
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
  return response.json();
}

beforeEach(async () => {
  await db.delete(auditEvents);
  await db.delete(referrals);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('GET /referrals/check: paginating the "Check referrals" screen', () => {
  it('returns forty rows a page and reports the uncapped total', async () => {
    const { testApp, token, world: w } = await world({ capacity: 50 });

    const ids: string[] = [];
    for (let i = 0; i < 45; i += 1) {
      const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
      // Distinct, increasing referredAt, so the order within a page rests on
      // that rather than on insertion order happening to agree with it.
      await setReferredAt(id, new Date(Date.parse(NOW) + i * 60_000).toISOString());
      ids.push(id);
    }
    // Newest referred first, so `ids`' own order is reversed on the screen.
    const newestFirst = [...ids].reverse();

    const first = await checkReferrals(testApp, token);
    expect(first.page).toBe(1);
    expect(first.pageSize).toBe(40);
    expect(first.totalCount).toBe(45);
    expect(first.referrals.map((r) => r.id)).toEqual(newestFirst.slice(0, 40));

    const second = await checkReferrals(testApp, token, '?page=2');
    expect(second.page).toBe(2);
    expect(second.totalCount).toBe(45);
    expect(second.referrals.map((r) => r.id)).toEqual(newestFirst.slice(40));
  });
});

describe('GET /referrals/check: sorting referrals that still need attention to the top', () => {
  it('shows a referral nobody has acted on yet above a settled one, whatever their relative ages', async () => {
    const { testApp, token, world: w } = await world();

    // Settled, and referred first - would sort first by date alone.
    const { id: reviewedEarly } = await submitReferral(
      testApp,
      w,
      {},
      { clientIp: nextClientIp() },
    );
    await review(testApp, token, reviewedEarly);
    await setReferredAt(reviewedEarly, new Date(Date.parse(NOW) - 60_000).toISOString());

    // Still needing attention, referred later - and still sorts first.
    const { id: pendingLate } = await submitReferral(testApp, w, UNKNOWN_REFERRER, {
      clientIp: nextClientIp(),
    });

    const { referrals: rows } = await checkReferrals(testApp, token);
    expect(rows.map((r) => r.id)).toEqual([pendingLate, reviewedEarly]);
  });
});

describe('GET /referrals/check: the thirty-day cutoff on a settled referral', () => {
  it('drops a reviewed referral once it was referred over thirty days ago, but keeps one still needing attention however old', async () => {
    const { testApp, token, world: w } = await world();

    const { id: reviewedStale } = await submitReferral(
      testApp,
      w,
      {},
      { clientIp: nextClientIp() },
    );
    await review(testApp, token, reviewedStale);
    await setReferredAt(reviewedStale, JUST_OUTSIDE_CUTOFF);

    const { id: reviewedAtCutoff } = await submitReferral(
      testApp,
      w,
      {},
      { clientIp: nextClientIp() },
    );
    await review(testApp, token, reviewedAtCutoff);
    await setReferredAt(reviewedAtCutoff, STALE_CUTOFF);

    const { id: pendingAncient } = await submitReferral(testApp, w, UNKNOWN_REFERRER, {
      clientIp: nextClientIp(),
    });
    await setReferredAt(pendingAncient, '2020-01-01T00:00:00.000Z');

    const { referrals: rows, totalCount } = await checkReferrals(testApp, token);
    // Attention-needing first, whatever its age, then the one settled
    // referral still inside the thirty days.
    expect(rows.map((r) => r.id)).toEqual([pendingAncient, reviewedAtCutoff]);
    expect(totalCount).toBe(2);
  });
});

describe('GET /referrals/check: a session hidden from a team lead', () => {
  it("is excluded from a team lead's paginated screen too, but not an admin's", async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    await db
      .update(sessions)
      .set({ status: 'cancelled', updatedAt: NOW })
      .where(eq(sessions.id, w.sessionId));

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const { referrals: leadRows } = await checkReferrals(lead, accessToken);
    expect(leadRows.map((r) => r.id)).not.toContain(id);

    const { referrals: adminRows } = await checkReferrals(testApp, token);
    expect(adminRows.map((r) => r.id)).toContain(id);
  });
});

describe('GET /referrals/check: narrowing the screen', () => {
  it('still applies the same attention-first, thirty-day-bounded rules when filtered by status', async () => {
    const { testApp, token, world: w } = await world();

    const { id: staleReviewed } = await submitReferral(
      testApp,
      w,
      {},
      { clientIp: nextClientIp() },
    );
    await review(testApp, token, staleReviewed);
    await setReferredAt(staleReviewed, JUST_OUTSIDE_CUTOFF);

    const { id: freshReviewed } = await submitReferral(
      testApp,
      w,
      {},
      { clientIp: nextClientIp() },
    );
    await review(testApp, token, freshReviewed);

    const { referrals: rows } = await checkReferrals(testApp, token, '?status=reviewed');
    expect(rows.map((r) => r.id)).toEqual([freshReviewed]);
  });
});

describe('GET /referrals (plain): unaffected by the "Check referrals" screen', () => {
  it('still returns every referral on a session unbounded, for running it, whatever their status or age', async () => {
    const { testApp, token, world: w } = await world({ capacity: 50 });

    const ids: string[] = [];
    for (let i = 0; i < 45; i += 1) {
      const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
      ids.push(id);
    }
    // A settled, decades-old referral — `GET /referrals/check` would drop
    // this; the plain list running a session relies on must not.
    await review(testApp, token, ids[0] ?? '');
    await setReferredAt(ids[0] ?? '', '2020-01-01T00:00:00.000Z');

    const { referrals: rows } = await listReferrals(testApp, token, `?sessionId=${w.sessionId}`);
    expect(rows).toHaveLength(45);
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(ids));
  });

  it('has no page, pageSize or totalCount in its response', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const response = await testApp.request('/api/v1/referrals', { headers: authHeaders(token) });
    const body: Record<string, unknown> = await response.json();
    expect(body).not.toHaveProperty('page');
    expect(body).not.toHaveProperty('pageSize');
    expect(body).not.toHaveProperty('totalCount');
  });
});
