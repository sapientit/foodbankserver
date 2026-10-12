import type { Clock } from '../../core/clock.ts';
import type { Logger } from '../../core/log.ts';
import { instantToLondonWallClock } from '../../core/time/london.ts';
import type { D1ExportClient } from './d1-export-client.ts';

export const EXPORT_DATABASE_JOB = 'export-database';

/** Every export lives under this prefix; the bucket's lifecycle rule deletes it after 30 days. */
export const EXPORT_PREFIX = 'exports/';

export interface ExportDatabaseResult {
  /** The R2 key written, or `undefined` when the job is not configured here. */
  readonly key: string | undefined;
}

/**
 * Copies a full export of the database into R2 — `INITIAL_SPEC1.txt`,
 * `#Backups and recovery`: a copy that does not depend on Cloudflare's own
 * seven-day Time Travel.
 *
 * ## Where it goes, and for how long
 *
 * `exports/YYYY-MM-DD.sql`, dated on the London calendar, in a private
 * EU-jurisdiction bucket bound as `EXPORTS`. **Nothing here deletes an
 * export**: the bucket's lifecycle rule (`expire-after-30-days`, prefix
 * `exports/`) does, so a broken job can only fail to add a copy, never remove
 * one. A second run on the same day overwrites that day's file.
 *
 * Each file holds every household's personal data and the fifteen-month
 * purge cannot reach it, which is why it lives thirty days and no longer.
 *
 * ## Streamed, not buffered
 *
 * The file goes from Cloudflare's download straight into R2 through a
 * fixed-length stream, so the Worker never holds the database in memory or
 * spends CPU on it. R2 needs the length up front for a stream, and
 * Cloudflare's download states one; without it the export is refused rather
 * than buffered.
 *
 * ## When it does nothing
 *
 * With no bucket or no export client — test and UAT, or production before
 * its token is set — it reports `undefined` and stops, the same way the
 * platform-usage job does.
 */
export async function exportDatabase(deps: {
  readonly bucket: R2Bucket | undefined;
  readonly client: D1ExportClient | undefined;
  readonly clock: Clock;
  readonly logger: Logger;
}): Promise<ExportDatabaseResult> {
  const { bucket, client, clock, logger } = deps;
  if (bucket === undefined || client === undefined) {
    return { key: undefined };
  }

  const key = `${EXPORT_PREFIX}${instantToLondonWallClock(clock.nowIso()).date}.sql`;
  const file = await client.exportDatabase();

  const length = Number(file.headers.get('content-length'));
  if (file.body === null || !Number.isSafeInteger(length) || length <= 0) {
    throw new Error('D1 export download had no usable length');
  }

  const { readable, writable } = new FixedLengthStream(length);
  await Promise.all([
    file.body.pipeTo(writable),
    bucket.put(key, readable, { httpMetadata: { contentType: 'application/sql' } }),
  ]);

  logger.info('exported database', { jobName: EXPORT_DATABASE_JOB });
  return { key };
}
