import type { ImportResult } from './dev-test-imports.service.ts';

export interface ReferralImportResponse {
  readonly sessionId: string;
  readonly importKey: string;
  readonly referrals: readonly { readonly sourceIndex: number; readonly referralId: string }[];
}

/**
 * The output allowlist, the same as every other route — trivial here, since
 * `ImportResult` already holds nothing but ids and a count, but named
 * explicitly rather than returned as-is so a field added to it later has to
 * pass through here to reach a response.
 */
export function toReferralImportResponse(result: ImportResult): ReferralImportResponse {
  return {
    sessionId: result.sessionId,
    importKey: result.importKey,
    referrals: result.referrals,
  };
}
