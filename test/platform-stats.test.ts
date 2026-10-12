import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createLogger } from '../src/core/log.ts';
import { createDatabase } from '../src/db/client.ts';
import { platformDailyStats, type PlatformDailyStats } from '../src/db/schema/platform-stats.ts';
import { systemJobs } from '../src/db/schema/jobs.ts';
import type { CloudflareAnalyticsClient } from '../src/modules/platform-stats/cloudflare-analytics-client.ts';
import { collectPlatformUsage } from '../src/modules/platform-stats/collect-usage.ts';
import { createPlatformStatsRepository } from '../src/modules/platform-stats/platform-stats.repository.ts';
import { runScheduledJobs } from '../src/modules/jobs/run-scheduled.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';

const db = createDatabase(env.DB);
const NOW = '2026-09-11T02:17:00.000Z'; // so "yesterday" (UTC) is 2026-09-10

const FULL_CONFIG = {
  cfAccountId: 'account-1',
  cfD1DatabaseId: 'db-1',
  cfWorkerScriptName: 'foodbank-server',
  cfAnalyticsApiToken: 'token-1',
};

function testLogger() {
  return createLogger('silent');
}

/** A full `platform_daily_stats` row, quiet apart from the given overrides. */
function rawRow(overrides: Partial<PlatformDailyStats> & { date: string }): PlatformDailyStats {
  return {
    workerRequestsAccountWide: 100,
    workerRequestsThisApp: 100,
    workerErrorsThisApp: 0,
    workerCpuTimeP99Us: 100,
    workerSubrequestsSum: 100,
    workerWallTimeP99Ms: 50,
    d1RowsRead: 100,
    d1RowsWritten: 10,
    d1StorageBytes: 1024,
    r2StorageBytes: 0,
    r2ClassAOperations: 0,
    r2ClassBOperations: 0,
    collectedAt: NOW,
    ...overrides,
  };
}

function fakeClient(usage: Partial<Record<string, number>> = {}): CloudflareAnalyticsClient {
  return {
    fetchDailyUsage: () =>
      Promise.resolve({
        workerRequestsAccountWide: usage.workerRequestsAccountWide ?? 1000,
        workerRequestsThisApp: usage.workerRequestsThisApp ?? 900,
        workerErrorsThisApp: usage.workerErrorsThisApp ?? 5,
        workerCpuTimeP99Us: usage.workerCpuTimeP99Us ?? 500,
        workerSubrequestsSum: usage.workerSubrequestsSum ?? 900,
        workerWallTimeP99Ms: usage.workerWallTimeP99Ms ?? 50,
        d1RowsRead: usage.d1RowsRead ?? 2000,
        d1RowsWritten: usage.d1RowsWritten ?? 100,
        d1StorageBytes: usage.d1StorageBytes ?? 4096,
        r2StorageBytes: usage.r2StorageBytes ?? 8192,
        r2ClassAOperations: usage.r2ClassAOperations ?? 20,
        r2ClassBOperations: usage.r2ClassBOperations ?? 30,
      }),
  };
}

beforeEach(async () => {
  await db.delete(platformDailyStats);
  await db.delete(systemJobs);
});

describe('collectPlatformUsage', () => {
  it('does nothing when the four Cloudflare settings are not all configured', async () => {
    const result = await collectPlatformUsage({
      repository: createPlatformStatsRepository(db),
      clock: fixedClock(NOW),
      logger: testLogger(),
      config: { ...FULL_CONFIG, cfAnalyticsApiToken: undefined },
    });

    expect(result).toEqual({ date: undefined, collected: false });
    const rows = await createPlatformStatsRepository(db).listRange('2000-01-01', '2100-01-01');
    expect(rows).toHaveLength(0);
  });

  it('captures yesterday’s UTC day, not today’s still-accumulating one', async () => {
    const repository = createPlatformStatsRepository(db);
    const result = await collectPlatformUsage({
      repository,
      clock: fixedClock(NOW),
      logger: testLogger(),
      config: FULL_CONFIG,
      analyticsClient: fakeClient(),
    });

    expect(result).toEqual({ date: '2026-09-10', collected: true });
    const [row] = await repository.listRange('2026-09-10', '2026-09-10');
    expect(row?.date).toBe('2026-09-10');
    expect(row?.workerRequestsAccountWide).toBe(1000);
    expect(row?.d1StorageBytes).toBe(4096);
  });

  it('replaces the same day on a second run rather than duplicating it', async () => {
    const repository = createPlatformStatsRepository(db);
    const deps = {
      repository,
      clock: fixedClock(NOW),
      logger: testLogger(),
      config: FULL_CONFIG,
    };

    await collectPlatformUsage({ ...deps, analyticsClient: fakeClient({ d1StorageBytes: 1 }) });
    await collectPlatformUsage({ ...deps, analyticsClient: fakeClient({ d1StorageBytes: 2 }) });

    const rows = await repository.listRange('2026-09-10', '2026-09-10');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.d1StorageBytes).toBe(2);
  });
});

describe('runScheduledJobs — platform usage does not block the real jobs', () => {
  it('reports the other jobs done even when platform usage is unconfigured', async () => {
    const result = await runScheduledJobs({
      db,
      clock: fixedClock(NOW),
      logger: testLogger(),
    });
    expect(result.platformUsageDate).toBeUndefined();
    expect(result.sessionsCreated).toBeGreaterThanOrEqual(0);
  });

  it('records a job failure without throwing when the analytics client fails', async () => {
    const failingClient: CloudflareAnalyticsClient = {
      fetchDailyUsage: () =>
        Promise.reject(new Error('Cloudflare GraphQL Analytics API refused the request: 500')),
    };

    const result = await runScheduledJobs({
      db,
      clock: fixedClock(NOW),
      logger: testLogger(),
      ...FULL_CONFIG,
      analyticsClient: failingClient,
    });

    // The scheduled run as a whole did not throw, and reports no date collected.
    expect(result.platformUsageDate).toBeUndefined();

    const [job] = await db
      .select()
      .from(systemJobs)
      .where(eq(systemJobs.name, 'collect-platform-usage'));
    expect(job?.lastError).toContain('refused the request');
  });
});

async function world(): Promise<{ testApp: TestApp; adminToken: string }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  return { testApp, adminToken: accessToken };
}

describe('GET /platform-stats/usage', () => {
  it('refuses an unauthenticated request', async () => {
    const { testApp } = await world();
    const response = await testApp.request(
      '/api/v1/platform-stats/usage?from=2026-09-01&to=2026-09-10',
    );
    expect(response.status).toBe(401);
  });

  it('refuses a team lead — this is about running the system, not the food bank’s work', async () => {
    const { testApp } = await world();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await testApp.request(
      '/api/v1/platform-stats/usage?from=2026-09-01&to=2026-09-10',
      {
        headers: authHeaders(accessToken),
      },
    );
    expect(response.status).toBe(403);
  });

  it('refuses a range with `to` before `from`', async () => {
    const { testApp, adminToken } = await world();
    const response = await testApp.request(
      '/api/v1/platform-stats/usage?from=2026-09-10&to=2026-09-01',
      {
        headers: authHeaders(adminToken),
      },
    );
    expect(response.status).toBe(400);
  });

  it('returns only the captured days in range, each with its measures against Cloudflare’s caps', async () => {
    const { testApp, adminToken } = await world();
    const repository = createPlatformStatsRepository(db);
    await collectPlatformUsage({
      repository,
      clock: fixedClock('2026-09-09T02:17:00.000Z'), // captures 2026-09-08
      logger: testLogger(),
      config: FULL_CONFIG,
      analyticsClient: fakeClient({ workerRequestsAccountWide: 99_000 }),
    });

    const response = await testApp.request(
      '/api/v1/platform-stats/usage?from=2026-09-01&to=2026-09-10',
      {
        headers: authHeaders(adminToken),
      },
    );
    expect(response.status).toBe(200);

    const body: {
      days: {
        date: string;
        workerRequestsAccountWide: {
          value: number;
          cap: number;
          threshold: number;
          exceeded: boolean;
        };
      }[];
    } = await response.json();

    expect(body.days).toHaveLength(1);
    expect(body.days[0]?.date).toBe('2026-09-08');
    expect(body.days[0]?.workerRequestsAccountWide).toEqual({
      value: 99_000,
      cap: 100_000,
      threshold: 80_000,
      exceeded: true,
    });
  });

  it('sums R2 operations month to date, resetting on the 1st, even reading days before `from`', async () => {
    const { testApp, adminToken } = await world();
    const repository = createPlatformStatsRepository(db);

    // Late August — must not leak into September's month-to-date sum.
    await repository.upsert(
      rawRow({ date: '2026-08-30', r2ClassAOperations: 500_000, r2ClassBOperations: 0 }),
    );
    await repository.upsert(
      rawRow({ date: '2026-08-31', r2ClassAOperations: 500_000, r2ClassBOperations: 0 }),
    );
    // September, including a day before the requested range's `from`.
    await repository.upsert(
      rawRow({ date: '2026-09-01', r2ClassAOperations: 10, r2ClassBOperations: 100 }),
    );
    await repository.upsert(
      rawRow({ date: '2026-09-02', r2ClassAOperations: 20, r2ClassBOperations: 200 }),
    );
    await repository.upsert(
      rawRow({ date: '2026-09-03', r2ClassAOperations: 30, r2ClassBOperations: 300 }),
    );

    // Requested range starts on the 2nd, mid-month — 2026-09-01 is outside it.
    const response = await testApp.request(
      '/api/v1/platform-stats/usage?from=2026-09-02&to=2026-09-03',
      { headers: authHeaders(adminToken) },
    );
    expect(response.status).toBe(200);

    const body: {
      days: {
        date: string;
        r2ClassAOperations: { value: number };
        r2ClassBOperations: { value: number };
      }[];
    } = await response.json();

    expect(body.days).toHaveLength(2);
    // 2026-09-02's month-to-date reads 2026-09-01 (outside the range) too: 10 + 20.
    expect(body.days[0]).toMatchObject({
      date: '2026-09-02',
      r2ClassAOperations: { value: 30 },
      r2ClassBOperations: { value: 300 },
    });
    // 2026-09-03 adds its own day: 10 + 20 + 30, resetting clean of August's totals.
    expect(body.days[1]).toMatchObject({
      date: '2026-09-03',
      r2ClassAOperations: { value: 60 },
      r2ClassBOperations: { value: 600 },
    });
  });

  it('marks R2 storage and month-to-date operations close to their caps, same as any other measure', async () => {
    const { testApp, adminToken } = await world();
    const repository = createPlatformStatsRepository(db);

    await repository.upsert(
      rawRow({
        date: '2026-09-05',
        r2StorageBytes: 8 * 1_000_000_000, // 80% of the 10 GB allowance
        r2ClassAOperations: 800_000, // 80% of the 1,000,000/month allowance
        r2ClassBOperations: 100,
      }),
    );

    const response = await testApp.request(
      '/api/v1/platform-stats/usage?from=2026-09-01&to=2026-09-10',
      { headers: authHeaders(adminToken) },
    );
    expect(response.status).toBe(200);

    const body: {
      days: {
        date: string;
        r2StorageBytes: { value: number; exceeded: boolean };
        r2ClassAOperations: { value: number; exceeded: boolean };
        r2ClassBOperations: { value: number; exceeded: boolean };
      }[];
    } = await response.json();

    expect(body.days[0]?.r2StorageBytes).toMatchObject({ exceeded: true });
    expect(body.days[0]?.r2ClassAOperations).toMatchObject({ exceeded: true });
    expect(body.days[0]?.r2ClassBOperations).toMatchObject({ exceeded: false });
  });
});

describe('GET /platform-stats/usage/alert-summary', () => {
  it('refuses a team lead', async () => {
    const { testApp } = await world();
    const { accessToken } = await devLogin(testApp, {
      email: 'lead2@foodbank.org',
      role: 'team_lead',
    });
    const response = await testApp.request('/api/v1/platform-stats/usage/alert-summary', {
      headers: authHeaders(accessToken),
    });
    expect(response.status).toBe(403);
  });

  it('counts only the days with a worrying measure, over the fourteen-day window', async () => {
    const { testApp, adminToken } = await world();
    const repository = createPlatformStatsRepository(db);

    // A clear day and a worrying day, both inside the last 14 days of NOW.
    await repository.upsert({
      date: '2026-09-05',
      workerRequestsAccountWide: 100,
      workerRequestsThisApp: 100,
      workerErrorsThisApp: 0,
      workerCpuTimeP99Us: 100,
      workerSubrequestsSum: 100,
      workerWallTimeP99Ms: 50,
      d1RowsRead: 100,
      d1RowsWritten: 10,
      d1StorageBytes: 1024,
      r2StorageBytes: 0,
      r2ClassAOperations: 0,
      r2ClassBOperations: 0,
      collectedAt: NOW,
    });
    await repository.upsert({
      date: '2026-09-06',
      workerRequestsAccountWide: 95_000, // over the 80,000 margin
      workerRequestsThisApp: 100,
      workerErrorsThisApp: 0,
      workerCpuTimeP99Us: 100,
      workerSubrequestsSum: 100,
      workerWallTimeP99Ms: 50,
      d1RowsRead: 100,
      d1RowsWritten: 10,
      d1StorageBytes: 1024,
      r2StorageBytes: 0,
      r2ClassAOperations: 0,
      r2ClassBOperations: 0,
      collectedAt: NOW,
    });
    // Outside the fourteen-day window ending 2026-09-11 (i.e. before 2026-08-29).
    await repository.upsert({
      date: '2026-08-01',
      workerRequestsAccountWide: 99_999,
      workerRequestsThisApp: 100,
      workerErrorsThisApp: 0,
      workerCpuTimeP99Us: 100,
      workerSubrequestsSum: 100,
      workerWallTimeP99Ms: 50,
      d1RowsRead: 100,
      d1RowsWritten: 10,
      d1StorageBytes: 1024,
      r2StorageBytes: 0,
      r2ClassAOperations: 0,
      r2ClassBOperations: 0,
      collectedAt: NOW,
    });

    const response = await testApp.request('/api/v1/platform-stats/usage/alert-summary', {
      headers: authHeaders(adminToken),
    });
    expect(response.status).toBe(200);

    const body: { windowDays: number; daysWithExceededThreshold: number } = await response.json();
    expect(body).toEqual({ windowDays: 14, daysWithExceededThreshold: 1 });
  });

  it('counts a day with only an R2 measure over its threshold, same as any other measure', async () => {
    const { testApp, adminToken } = await world();
    const repository = createPlatformStatsRepository(db);

    // Clear in every way except R2 storage, which alone crosses 80% of 10 GB.
    await repository.upsert(rawRow({ date: '2026-09-05', r2StorageBytes: 9 * 1_000_000_000 }));
    // Clear in every way except R2 Class B operations, month to date.
    await repository.upsert(rawRow({ date: '2026-09-06', r2ClassBOperations: 9_000_000 }));

    const response = await testApp.request('/api/v1/platform-stats/usage/alert-summary', {
      headers: authHeaders(adminToken),
    });
    expect(response.status).toBe(200);

    const body: { windowDays: number; daysWithExceededThreshold: number } = await response.json();
    expect(body).toEqual({ windowDays: 14, daysWithExceededThreshold: 2 });
  });
});
