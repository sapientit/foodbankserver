import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloudflareAnalyticsClient } from '../src/modules/platform-stats/cloudflare-analytics-client.ts';

const CONFIG = {
  accountId: 'account-1',
  apiToken: 'token-1',
  workerScriptName: 'foodbank-server',
  d1DatabaseId: 'db-1',
};

/** A real GraphQL success body — `errors` comes back `null`, not omitted. Confirmed live. */
function graphqlSuccessBody() {
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
    });
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
