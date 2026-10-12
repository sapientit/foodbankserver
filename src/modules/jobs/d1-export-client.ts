const API_ROOT = 'https://api.cloudflare.com/client/v4';

/**
 * At most this many requests to the export endpoint per run, three seconds
 * apart — a minute in all. The free plan allows 50 outgoing requests per
 * invocation, shared with the platform-usage job in the same nightly run, so
 * the bound is on requests rather than time. Today's database finishes in one
 * or two; **revisit once production has real volume** — an export that runs
 * longer is recorded as a failed `export-database` job, not lost silently.
 */
const MAX_POLLS = 20;
const POLL_INTERVAL_MS = 3_000;

export interface D1ExportConfig {
  readonly accountId: string;
  readonly databaseId: string;
  readonly apiToken: string;
}

export interface D1ExportClient {
  /**
   * Asks Cloudflare for a full SQL export (schema and data) of the database
   * and waits for it to finish. Resolves to the export file's response, ready
   * to be streamed — the signed URL behind it is a credential and is never
   * returned, logged or put in an error.
   */
  exportDatabase(): Promise<Response>;
}

interface ExportEnvelope {
  readonly success?: boolean;
  readonly result?: {
    readonly status?: string;
    readonly at_bookmark?: string;
    readonly error?: string;
    readonly result?: { readonly signed_url?: string };
  };
}

export interface D1ExportClientOptions {
  /** Overridden in tests so no real Cloudflare account is ever needed. */
  readonly fetch?: typeof fetch;
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * Calls Cloudflare's D1 export API: `POST .../d1/database/{id}/export` with
 * `output_format: 'polling'`, repeated with the returned `at_bookmark` until
 * the status is `complete`, at which point `result.signed_url` points at the
 * finished `.sql` file for an hour.
 *
 * A Worker cannot run `wrangler d1 export`, and building the dump itself from
 * the `DB` binding would outgrow the free plan's 10 ms of CPU per invocation
 * as the database grows — Cloudflare does the work here instead. The price is
 * an API token with D1 Edit on the account, accepted by Pete on 2026-10-12.
 *
 * Errors carry an HTTP status or Cloudflare's own status word, never the
 * token, the signed URL or a response body.
 */
export function createD1ExportClient(
  config: D1ExportConfig,
  options: D1ExportClientOptions = {},
): D1ExportClient {
  const fetchImpl = options.fetch ?? fetch;
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const endpoint = `${API_ROOT}/accounts/${config.accountId}/d1/database/${config.databaseId}/export`;

  /**
   * A network failure's own message is never passed on: whether it names the
   * URL depends on the runtime, and the download URL is a credential. Same
   * shape as `cloudflare-analytics-client.ts`.
   */
  async function send(url: string, init: RequestInit | undefined, what: string): Promise<Response> {
    try {
      return await fetchImpl(url, init);
    } catch {
      throw new Error(`D1 export ${what} could not reach Cloudflare`);
    }
  }

  async function poll(bookmark: string | undefined): Promise<ExportEnvelope['result']> {
    const response = await send(
      endpoint,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          output_format: 'polling',
          ...(bookmark === undefined ? {} : { current_bookmark: bookmark }),
        }),
      },
      'request',
    );
    if (!response.ok) {
      throw new Error(`D1 export request failed with HTTP ${String(response.status)}`);
    }
    const envelope: ExportEnvelope = await response.json();
    if (envelope.success === false) {
      throw new Error('D1 export request was refused by Cloudflare');
    }
    return envelope.result;
  }

  return {
    async exportDatabase() {
      let bookmark: string | undefined;
      for (let attempt = 1; attempt <= MAX_POLLS; attempt += 1) {
        const result = await poll(bookmark);
        if (result?.status === 'complete') {
          const signedUrl = result.result?.signed_url;
          if (signedUrl === undefined) {
            throw new Error('D1 export completed without a download URL');
          }
          const file = await send(signedUrl, undefined, 'download');
          if (!file.ok || file.body === null) {
            throw new Error(`D1 export download failed with HTTP ${String(file.status)}`);
          }
          return file;
        }
        if (result?.status === 'error') {
          throw new Error('D1 export failed at Cloudflare');
        }
        bookmark = result?.at_bookmark ?? bookmark;
        await wait(POLL_INTERVAL_MS);
      }
      throw new Error(`D1 export did not finish within ${String(MAX_POLLS)} polls`);
    },
  };
}
