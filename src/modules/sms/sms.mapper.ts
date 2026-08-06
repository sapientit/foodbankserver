import type { SmsMessage } from '../../db/schema/sms.ts';

/**
 * Response mappers are the output allowlist here too, but **there is no
 * per-role field split within a message** — unlike `referrals.mapper.ts`,
 * which withholds `reasonId` and `reviewComment` from a team lead on the same
 * response an admin gets.
 *
 * The role split for SMS lives at the *route* level instead: a team lead can
 * reach a referral's thread and reply to it — a deliberate second exception
 * to "a team lead does not see the reason for referral", the same kind as the
 * listener sheet — but the loose-reply routes (`GET /sms-messages/unmatched`,
 * `POST /sms-messages/:id/read`) are `requireRole('admin')` only and a team
 * lead's token never reaches this mapper for one. So once a caller is allowed
 * to see a message at all, they may see the whole of it.
 */

export interface SmsMessageResponse {
  readonly id: string;
  readonly referralId: string | null;
  readonly kind: string;
  readonly phone: string;
  readonly body: string;
  readonly occurredAt: string;
  readonly readAt: string | null;
}

export function toSmsMessageResponse(message: SmsMessage): SmsMessageResponse {
  return {
    id: message.id,
    referralId: message.referralId,
    kind: message.kind,
    phone: message.phone,
    body: message.body,
    occurredAt: message.occurredAt,
    readAt: message.readAt,
  };
}

export interface SmsHouseholdSummary {
  readonly referralId: string;
  /** Whether a reminder has gone for this referral — `sms_reminder_sent_at IS NOT NULL`. */
  readonly sent: boolean;
  /** Inbound only: `household_reply` and `failure`. See `sms.repository.ts`. */
  readonly messageCount: number;
  readonly unreadCount: number;
}

export interface SmsSessionSummaryResponse {
  readonly sessionId: string;
  readonly unreadTotal: number;
  readonly households: SmsHouseholdSummary[];
}

/**
 * What one press of the button did.
 *
 * `alreadyReminded` is here so a second press reads as "nothing to do" rather
 * than as a failure: pressing it again on a fully-texted session otherwise
 * returns zeroes, which looks broken. `failed` is the number the screen should
 * make loud — those are households who still do not know when to come.
 */
export interface SmsSendResultResponse {
  readonly sessionId: string;
  readonly reminded: number;
  readonly failed: number;
  readonly alreadyReminded: number;
}
