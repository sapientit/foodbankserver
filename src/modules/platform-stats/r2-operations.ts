/**
 * Classifies one R2 `actionType` into Cloudflare's Class A / Class B billing
 * split, or free (counts toward neither) — see `INITIAL_SPEC1.txt`,
 * `#Platform usage monitoring`, and `cloudflare-analytics-client.ts`, which
 * calls this once per actionType row the GraphQL API returns.
 *
 * Pure and I/O-free on purpose, same as `thresholds.ts` — this is the one
 * place the classification lives, so a new Cloudflare action type is one
 * line to add rather than a guess repeated at every call site.
 */

export type R2OperationClass = 'classA' | 'classB' | 'free';

/**
 * Read-like operations, billed as Class B. Source: developers.cloudflare.com,
 * 2026-10-12 — see the task that introduced this file.
 */
const CLASS_B_ACTIONS: ReadonlySet<string> = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);

/** Free actions — counted in neither class. Same source as `CLASS_B_ACTIONS`. */
const FREE_ACTIONS: ReadonlySet<string> = new Set([
  'DeleteObject',
  'DeleteBucket',
  'AbortMultipartUpload',
]);

/**
 * Write-like operations, billed as Class A: `ListBuckets`, `PutBucket`,
 * `ListObjects`, `PutObject`, `CopyObject`, `CompleteMultipartUpload`,
 * `CreateMultipartUpload`, `LifecycleStorageTierTransition`,
 * `ListMultipartUploads`, `UploadPart`, `UploadPartCopy`, `ListParts`,
 * `PutBucketEncryption`, `PutBucketCors`, `PutBucketLifecycleConfiguration`.
 * Not checked explicitly below — see the fallthrough comment on
 * `classifyR2Action`.
 *
 * `actionType` not in that list, in `CLASS_B_ACTIONS` or in `FREE_ACTIONS`
 * (Cloudflare adds action types over time, and this list cannot be kept
 * exhaustive from outside a live account) is classified Class A — the more
 * conservative, cheaper-to-exhaust class — rather than silently dropped.
 */
export function classifyR2Action(actionType: string): R2OperationClass {
  if (CLASS_B_ACTIONS.has(actionType)) return 'classB';
  if (FREE_ACTIONS.has(actionType)) return 'free';
  return 'classA';
}
