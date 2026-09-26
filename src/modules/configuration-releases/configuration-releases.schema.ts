import { z } from 'zod';

/**
 * The server stores a release exactly as the uploader sent it and never reads
 * it — see the doc comment on `db/schema/configuration-releases.ts`. So
 * `questionnaire` and `rules` are validated only on **size**: they are not
 * parsed, not checked as JSON, and not trimmed. Storing precisely what was
 * sent is the point — the uploader's hashes describe those exact bytes.
 */
const releaseDocument = z.string().min(1).max(500_000);

/**
 * The uploader's manifest: opaque identifiers and hashes generated outside
 * this server. None of these are re-derived or checked against the documents
 * above — see `configuration-releases.service.ts`. `generatedAt` is not
 * required to be an ISO timestamp; it is the uploader's own value, kept for
 * audit only.
 */
const manifestField = z.string().min(1).max(200);
const generatedAt = z.string().min(1).max(100);

export const configurationReleaseUploadSchema = z.object({
  questionnaire: releaseDocument,
  rules: releaseDocument,
  questionnaireHash: manifestField,
  rulesHash: manifestField,
  generationId: manifestField,
  generatedAt,
  sourceWorkbookId: manifestField,
});

export type ConfigurationReleaseUploadInput = z.infer<typeof configurationReleaseUploadSchema>;

/** `GET /configuration-releases/bulk?formIds=...` reads at most this many at once. */
export const MAX_BULK_FORM_IDS = 50;

/**
 * `formIds` arrives as one comma-separated query value. Split, then validated
 * as a whole: a non-uuid entry or too many ids fails the request before any
 * database access, rather than silently dropping the bad one.
 */
export const bulkFormIdsQuerySchema = z.object({
  formIds: z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.uuid()).min(1).max(MAX_BULK_FORM_IDS)),
});
