import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createLogger } from '../src/core/log.ts';
import { createDatabase } from '../src/db/client.ts';
import { systemJobs } from '../src/db/schema/jobs.ts';
import { createD1ExportClient, type D1ExportClient } from '../src/modules/jobs/d1-export-client.ts';
import { exportDatabase, EXPORT_DATABASE_JOB } from '../src/modules/jobs/export-database.ts';
import { runScheduledJobs } from '../src/modules/jobs/run-scheduled.ts';

/**
 * `INITIAL_SPEC1.txt`, `#Backups and recovery`: the database is exported
 * every night into R2, kept apart from Cloudflare's own Time Travel.
 */

const db = createDatabase(env.DB);
const bucket: R2Bucket = (() => {
  // Bound for tests in `vitest.config.ts`; production is the only deployed
  // environment that has it, so the generated type says it may be absent.
  if (env.EXPORTS === undefined) throw new Error('EXPORTS is not bound in vitest.config.ts');
  return env.EXPORTS;
})();
// 23:30 UTC in October is 00:30 the next day in London: the file is dated on
// the London calendar, so this is the instant that catches the wrong clock.
const NOW = '2026-10-12T23:30:00.000Z';
const TOKEN = 'secret-token-value';
const SIGNED_URL = 'https://export.example/signed?X-Amz-Signature=very-secret';
const DUMP = 'CREATE TABLE "x" (id text);\nINSERT INTO "x" VALUES(\'1\');\n';

const config = { accountId: 'acct', databaseId: 'db-id', apiToken: TOKEN };
const noWait = (): Promise<void> => Promise.resolve();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function dumpResponse(body = DUMP): Response {
  return new Response(body, {
    headers: { 'content-length': String(new TextEncoder().encode(body).byteLength) },
  });
}

/** A fake Cloudflare: `pending` polls answer "active", then "complete". */
function fakeCloudflare(pending = 1) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let polls = 0;
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    if (url === SIGNED_URL) return Promise.resolve(dumpResponse());
    polls += 1;
    if (polls <= pending) {
      return Promise.resolve(
        json({ success: true, result: { status: 'active', at_bookmark: 'bm-1' } }),
      );
    }
    return Promise.resolve(
      json({
        success: true,
        result: { status: 'complete', at_bookmark: 'bm-1', result: { signed_url: SIGNED_URL } },
      }),
    );
  };
  return { fetchImpl, calls };
}

/** The JSON the client sent; it only ever sends a string body. */
function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

const failingClient: D1ExportClient = {
  exportDatabase: () => Promise.reject(new Error('D1 export failed at Cloudflare')),
};

beforeEach(async () => {
  await db.delete(systemJobs);
  const listed = await bucket.list();
  for (const object of listed.objects) await bucket.delete(object.key);
});

describe('the D1 export client', () => {
  it('polls with the bookmark Cloudflare returns until the export is complete, then downloads it', async () => {
    const cloudflare = fakeCloudflare(2);
    const client = createD1ExportClient(config, { fetch: cloudflare.fetchImpl, wait: noWait });

    const file = await client.exportDatabase();

    expect(await file.text()).toBe(DUMP);
    const polls = cloudflare.calls.filter((call) => call.url !== SIGNED_URL);
    expect(polls).toHaveLength(3);
    expect(polls[0]?.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db-id/export',
    );
    expect(new Headers(polls[0]?.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(bodyOf(polls[0]?.init)).toEqual({ output_format: 'polling' });
    expect(bodyOf(polls[1]?.init)).toEqual({
      output_format: 'polling',
      current_bookmark: 'bm-1',
    });
  });

  it('gives up after a bounded number of polls rather than spending the run', async () => {
    const cloudflare = fakeCloudflare(1_000);
    const client = createD1ExportClient(config, { fetch: cloudflare.fetchImpl, wait: noWait });

    await expect(client.exportDatabase()).rejects.toThrow(/did not finish/);
    expect(cloudflare.calls.length).toBeLessThanOrEqual(20);
  });

  it('never puts the token or the signed URL in an error', async () => {
    const failures: Response[] = [
      json({}, 403),
      json({ success: false, errors: [{ message: TOKEN }] }),
      json({ success: true, result: { status: 'error', error: SIGNED_URL } }),
    ];
    for (const failure of failures) {
      const client = createD1ExportClient(config, {
        fetch: () => Promise.resolve(failure.clone()),
        wait: noWait,
      });
      const error = await client.exportDatabase().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain('very-secret');
    }
  });
});

describe('a network failure in the export client', () => {
  it('never passes on a thrown fetch error that names the signed URL or the token', async () => {
    const cloudflare = fakeCloudflare();
    for (const failing of ['request', 'download'] as const) {
      const client = createD1ExportClient(config, {
        fetch: (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          const isDownload = url === SIGNED_URL;
          if ((failing === 'download') === isDownload) {
            return Promise.reject(new Error(`connection reset fetching ${url} with ${TOKEN}`));
          }
          return cloudflare.fetchImpl(input, init);
        },
        wait: noWait,
      });

      const error = await client.exportDatabase().then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : '';
      expect(message).toMatch(/could not reach Cloudflare/);
      expect(message).not.toContain('very-secret');
      expect(message).not.toContain(TOKEN);
    }
  });
});

describe('exporting the database into R2', () => {
  it('writes the whole export to exports/<London date>.sql', async () => {
    const cloudflare = fakeCloudflare();
    const client = createD1ExportClient(config, { fetch: cloudflare.fetchImpl, wait: noWait });

    const result = await exportDatabase({
      bucket,
      client,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
    });

    expect(result.key).toBe('exports/2026-10-13.sql');
    const stored = await bucket.get('exports/2026-10-13.sql');
    expect(await stored?.text()).toBe(DUMP);
    expect(stored?.httpMetadata?.contentType).toBe('application/sql');
  });

  it('does nothing where it is not configured', async () => {
    const result = await exportDatabase({
      bucket: undefined,
      client: undefined,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
    });

    expect(result.key).toBeUndefined();
    expect((await bucket.list()).objects).toHaveLength(0);
  });

  it('refuses a download with no length rather than buffering it', async () => {
    const client: D1ExportClient = {
      exportDatabase: () => Promise.resolve(new Response(DUMP)),
    };

    await expect(
      exportDatabase({ bucket, client, clock: fixedClock(NOW), logger: createLogger('silent') }),
    ).rejects.toThrow(/no usable length/);
    expect((await bucket.list()).objects).toHaveLength(0);
  });
});

describe('the nightly run', () => {
  it('records a successful export against its own job and reports the key', async () => {
    const cloudflare = fakeCloudflare();
    const result = await runScheduledJobs({
      db,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
      exportBucket: bucket,
      exportClient: createD1ExportClient(config, { fetch: cloudflare.fetchImpl, wait: noWait }),
    });

    expect(result.databaseExport).toBe('exports/2026-10-13.sql');
    const [job] = await db
      .select()
      .from(systemJobs)
      .where(eq(systemJobs.name, EXPORT_DATABASE_JOB));
    expect(job?.lastSuccessAt).toBe(NOW);
  });

  it('records a failed export without failing the jobs that ran before it', async () => {
    const result = await runScheduledJobs({
      db,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
      exportBucket: bucket,
      exportClient: failingClient,
    });

    expect(result.databaseExport).toBeUndefined();
    const [job] = await db
      .select()
      .from(systemJobs)
      .where(eq(systemJobs.name, EXPORT_DATABASE_JOB));
    expect(job?.lastError).toBe('D1 export failed at Cloudflare');
    expect(job?.lastSuccessAt).toBeNull();
    const [sessions] = await db
      .select()
      .from(systemJobs)
      .where(eq(systemJobs.name, 'session-materialisation'));
    expect(sessions?.lastSuccessAt).toBe(NOW);
  });

  it('skips the export entirely where it is not configured', async () => {
    const result = await runScheduledJobs({
      db,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
    });

    expect(result.databaseExport).toBeUndefined();
    expect(
      await db.select().from(systemJobs).where(eq(systemJobs.name, EXPORT_DATABASE_JOB)),
    ).toHaveLength(0);
  });
});
