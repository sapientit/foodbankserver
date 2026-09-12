import { addDays, type PlainDate } from '../../core/time/plain-date.ts';

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

export interface RawPlatformUsage {
  readonly workerRequestsAccountWide: number;
  readonly workerRequestsThisApp: number;
  readonly workerErrorsThisApp: number;
  readonly workerCpuTimeP99Us: number;
  readonly workerSubrequestsSum: number;
  readonly workerWallTimeP99Ms: number;
  readonly d1RowsRead: number;
  readonly d1RowsWritten: number;
  readonly d1StorageBytes: number;
}

export interface CloudflareAnalyticsConfig {
  readonly accountId: string;
  readonly apiToken: string;
  readonly workerScriptName: string;
  readonly d1DatabaseId: string;
}

export interface CloudflareAnalyticsClient {
  /** One completed UTC day's usage — see `platform-stats.ts` for why UTC. */
  fetchDailyUsage(date: PlainDate): Promise<RawPlatformUsage>;
}

const QUERY = `
  query PlatformUsage(
    $accountTag: string!
    $start: Time!
    $end: Time!
    $scriptName: string!
    $dayStart: Date!
    $dayEnd: Date!
    $databaseId: string!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        accountWide: workersInvocationsAdaptive(
          filter: { datetime_geq: $start, datetime_lt: $end }
          limit: 1
        ) {
          sum { requests }
        }
        thisApp: workersInvocationsAdaptive(
          filter: { datetime_geq: $start, datetime_lt: $end, scriptName: $scriptName }
          limit: 1
        ) {
          sum { requests errors subrequests }
          quantiles { cpuTimeP99 wallTimeP99 }
        }
        d1: d1AnalyticsAdaptiveGroups(
          filter: { date_geq: $dayStart, date_leq: $dayEnd, databaseId: $databaseId }
          limit: 1
        ) {
          sum { rowsRead rowsWritten }
        }
      }
    }
  }
`;

interface GraphQlResponse {
  readonly data: {
    readonly viewer: {
      readonly accounts: readonly {
        readonly accountWide: readonly { readonly sum: { readonly requests: number } }[];
        readonly thisApp: readonly {
          readonly sum: {
            readonly requests: number;
            readonly errors: number;
            readonly subrequests: number;
          };
          readonly quantiles: {
            readonly cpuTimeP99: number;
            readonly wallTimeP99: number;
          };
        }[];
        readonly d1: readonly {
          readonly sum: { readonly rowsRead: number; readonly rowsWritten: number };
        }[];
      }[];
    };
  } | null;
  /**
   * Present, `null` and `[]` are all observed on real Cloudflare responses —
   * confirmed against a live account, see `collect-usage.ts`'s job history.
   * Never assume `undefined` is the only "no errors" shape here.
   */
  readonly errors?: readonly { readonly message: string }[] | null;
}

interface D1DatabaseResponse {
  readonly result: { readonly file_size: number } | null;
  readonly success: boolean;
  readonly errors?: readonly { readonly message: string }[] | null;
}

/**
 * Calls Cloudflare's own GraphQL Analytics API and D1 REST API for this
 * deployment's own Worker and database. See `INITIAL_SPEC1.txt`,
 * `#Platform usage monitoring`.
 *
 * **The exact GraphQL shape here is unverified against a live account** —
 * there is no Cloudflare account available to test this against from this
 * codebase, the same gap `sms/provider.ts` flags for TheSMSWorks' response
 * body. Confirm field and filter names (`workersInvocationsAdaptive`,
 * `d1AnalyticsAdaptiveGroups`, and in particular whether `databaseId` is a
 * valid filter key on the D1 dataset) against a real account before relying
 * on this in production, and watch for the GraphQL API's habit of returning
 * `200` with an `errors` array on a bad query rather than a failing status.
 *
 * Never throws a raw fetch/parse error uninspected — `collectPlatformUsage`
 * relies on this rejecting with a message safe to log (no request bodies,
 * no tokens), same as every other outbound call in this codebase.
 */
export function createCloudflareAnalyticsClient(
  config: CloudflareAnalyticsConfig,
): CloudflareAnalyticsClient {
  return {
    async fetchDailyUsage(date: PlainDate): Promise<RawPlatformUsage> {
      const nextDate = addDays(date, 1);

      const graphql = await postGraphQl(config, {
        accountTag: config.accountId,
        start: `${date}T00:00:00Z`,
        end: `${nextDate}T00:00:00Z`,
        scriptName: config.workerScriptName,
        dayStart: date,
        dayEnd: date,
        databaseId: config.d1DatabaseId,
      });

      const account = graphql.data?.viewer.accounts[0];
      if (account === undefined) {
        throw new Error('Cloudflare GraphQL Analytics API returned no account row');
      }

      const accountWide = account.accountWide[0];
      const thisApp = account.thisApp[0];
      const d1 = account.d1[0];

      const storageBytes = await fetchD1StorageBytes(config);

      return {
        workerRequestsAccountWide: accountWide?.sum.requests ?? 0,
        workerRequestsThisApp: thisApp?.sum.requests ?? 0,
        workerErrorsThisApp: thisApp?.sum.errors ?? 0,
        workerCpuTimeP99Us: Math.round(thisApp?.quantiles.cpuTimeP99 ?? 0),
        workerSubrequestsSum: thisApp?.sum.subrequests ?? 0,
        workerWallTimeP99Ms: Math.round(thisApp?.quantiles.wallTimeP99 ?? 0),
        d1RowsRead: d1?.sum.rowsRead ?? 0,
        d1RowsWritten: d1?.sum.rowsWritten ?? 0,
        d1StorageBytes: storageBytes,
      };
    },
  };
}

async function postGraphQl(
  config: CloudflareAnalyticsConfig,
  variables: Record<string, string>,
): Promise<GraphQlResponse> {
  let response: Response;
  try {
    response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: QUERY, variables }),
    });
  } catch {
    throw new Error('Cloudflare GraphQL Analytics API request failed');
  }

  if (!response.ok) {
    throw new Error(
      `Cloudflare GraphQL Analytics API refused the request: ${String(response.status)}`,
    );
  }

  let parsed: GraphQlResponse;
  try {
    parsed = await response.json();
  } catch {
    throw new Error('Cloudflare GraphQL Analytics API returned a non-JSON response');
  }

  // The API returns HTTP 200 even when the query itself failed — and
  // `errors` comes back `null` on success, not omitted or `[]`. Checking
  // `!== undefined` alone reads `.length` on `null` and throws a confusing
  // TypeError instead of the intended error message; confirmed live.
  const graphqlErrors = errorMessages(parsed.errors);
  if (graphqlErrors.length > 0) {
    throw new Error(`Cloudflare GraphQL Analytics API query failed: ${graphqlErrors.join('; ')}`);
  }

  return parsed;
}

async function fetchD1StorageBytes(config: CloudflareAnalyticsConfig): Promise<number> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.d1DatabaseId}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${config.apiToken}` },
    });
  } catch {
    throw new Error('Cloudflare D1 REST API request failed');
  }

  if (!response.ok) {
    throw new Error(`Cloudflare D1 REST API refused the request: ${String(response.status)}`);
  }

  let parsed: D1DatabaseResponse;
  try {
    parsed = await response.json();
  } catch {
    throw new Error('Cloudflare D1 REST API returned a non-JSON response');
  }

  if (!parsed.success || parsed.result === null) {
    const errors = errorMessages(parsed.errors);
    const detail = errors.length > 0 ? errors.join('; ') : 'no result';
    throw new Error(`Cloudflare D1 REST API query failed: ${detail}`);
  }

  return parsed.result.file_size;
}

/**
 * `errors` is `null`, `[]` or an array on real responses — never assume
 * `undefined` is the only "no errors" shape. Written as a named helper
 * rather than an inline `Array.isArray` guard because that guard narrows a
 * readonly array to `any[]` here, which is worse than this being explicit.
 */
function errorMessages(
  errors: readonly { readonly message: string }[] | null | undefined,
): string[] {
  return errors === null || errors === undefined ? [] : errors.map((e) => e.message);
}
