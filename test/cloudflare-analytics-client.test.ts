import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloudflareAnalyticsClient } from '../src/modules/platform-stats/cloudflare-analytics-client.ts';

const CONFIG = {
  accountId: 'account-1',
  apiToken: 'token-1',
  workerScriptName: 'foodbank-server',
  d1DatabaseId: 'db-1',
};

/** A real GraphQL success body — `errors` comes back `null`, not omitted. Confirmed live. */
function graphqlSuccessBody(r2Overrides: { r2Storage?: unknown; r2Operations?: unknown } = {}) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            accountWide: [{ sum: { requests: 212 } }],
            thisApp: [
              {
                sum: { requests: 115, errors: 0, subrequests: 0 },
                quantiles: { cpuTimeP99: 52537, wallTimeP99: 800934 },
              },
            ],
            d1: [{ sum: { rowsRead: 60489, rowsWritten: 1705 } }],
            r2Storage:
              'r2Storage' in r2Overrides
                ? r2Overrides.r2Storage
                : [{ max: { payloadSize: 500_000, metadataSize: 1_000 } }],
            r2Operations:
              'r2Operations' in r2Overrides
                ? r2Overrides.r2Operations
                : [
                    { sum: { requests: 40 }, dimensions: { actionType: 'PutObject' } },
                    { sum: { requests: 60 }, dimensions: { actionType: 'GetObject' } },
                    { sum: { requests: 5 }, dimensions: { actionType: 'DeleteObject' } },
                    { sum: { requests: 2 }, dimensions: { actionType: 'SomeFutureAction' } },
                  ],
          },
        ],
      },
    },
    errors: null,
  };
}

function d1SuccessBody() {
  return { result: { file_size: 786432 }, errors: [], messages: [], success: true };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createCloudflareAnalyticsClient', () => {
  it('parses a real success response, including GraphQL’s `errors: null`', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(graphqlSuccessBody()))
      .mockResolvedValueOnce(jsonResponse(d1SuccessBody()));

    const client = createCloudflareAnalyticsClient(CONFIG);
    const usage = await client.fetchDailyUsage('2026-09-10');

    expect(usage).toEqual({
      workerRequestsAccountWide: 212,
      workerRequestsThisApp: 115,
      workerErrorsThisApp: 0,
      workerCpuTimeP99Us: 52537,
      workerSubrequestsSum: 0,
      workerWallTimeP99Ms: 800934,
      d1RowsRead: 60489,
      d1RowsWritten: 1705,
      d1StorageBytes: 786432,
      // 500,000 + 1,000 — the day's storage snapshot.
      r2StorageBytes: 501_000,
      // PutObject (Class A, 40) + SomeFutureAction (unknown → Class A, 2).
      r2ClassAOperations: 42,
      // GetObject (Class B, 60) only — DeleteObject is free, counted in neither.
      r2ClassBOperations: 60,
    });
  });

  it('records zero R2 usage when the datasets come back `null`, not fail', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(graphqlSuccessBody({ r2Storage: null, r2Operations: null })),
      )
      .mockResolvedValueOnce(jsonResponse(d1SuccessBody()));

    const client = createCloudflareAnalyticsClient(CONFIG);
    const usage = await client.fetchDailyUsage('2026-09-10');

    expect(usage.r2StorageBytes).toBe(0);
    expect(usage.r2ClassAOperations).toBe(0);
    expect(usage.r2ClassBOperations).toBe(0);
  });

  it('records zero R2 usage when the datasets come back empty — R2 enabled, no activity that day', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(graphqlSuccessBody({ r2Storage: [], r2Operations: [] })))
      .mockResolvedValueOnce(jsonResponse(d1SuccessBody()));

    const client = createCloudflareAnalyticsClient(CONFIG);
    const usage = await client.fetchDailyUsage('2026-09-10');

    expect(usage.r2StorageBytes).toBe(0);
    expect(usage.r2ClassAOperations).toBe(0);
    expect(usage.r2ClassBOperations).toBe(0);
  });

  it('reports a genuine GraphQL query error (an array, not null) as a thrown message rather than partial data', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: null, errors: [{ message: 'filter is required' }] }),
    );

    const client = createCloudflareAnalyticsClient(CONFIG);
    await expect(client.fetchDailyUsage('2026-09-10')).rejects.toThrow('filter is required');
  });

  it('reports a D1 REST auth failure as a thrown message rather than crashing on `errors: null`', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(graphqlSuccessBody())).mockResolvedValueOnce(
      jsonResponse({
        result: null,
        success: false,
        errors: [{ message: 'Authentication error' }],
      }),
    );

    const client = createCloudflareAnalyticsClient(CONFIG);
    await expect(client.fetchDailyUsage('2026-09-10')).rejects.toThrow('Authentication error');
  });

  it('reports an HTTP-level refusal without crashing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }));

    const client = createCloudflareAnalyticsClient(CONFIG);
    await expect(client.fetchDailyUsage('2026-09-10')).rejects.toThrow('403');
  });
});
