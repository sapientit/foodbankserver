import { SMS_MESSAGE_RETENTION_DAYS } from '../../config/constants.ts';

/**
 * The instant before which a text message is due for the nightly purge.
 *
 * Pure so `purge-sms.ts` and the administrator inbox queries compute the same
 * cutoff the same way — the inbox has to exclude what the purge would delete
 * even on the day the nightly job has not yet run.
 */
export function smsRetentionCutoffIso(nowIso: string): string {
  return new Date(
    Date.parse(nowIso) - SMS_MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}
