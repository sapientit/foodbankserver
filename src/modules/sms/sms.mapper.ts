import type { SmsMessage } from '../../db/schema/sms.ts';
import type { Session, SessionStatus } from '../../db/schema/sessions.ts';

/**
 * Response mappers are the output allowlist here too, but **there is no
 * per-role field split within a message** — unlike `referrals.mapper.ts`,
 * which withholds `reasonId` and `reviewComment` from a team lead on the same
 * response an admin gets.
 *
 * The role split for SMS lives at the *route* level instead: a team lead can
 * reach a referral's thread and reply to it — a deliberate second exception
 * to "a team lead does not see the reason for referral", the same kind as the
 * listener sheet — but the administrator-inbox routes (`GET
 * /sms-messages/unmatched`, `GET /sms-messages`, `GET
 * /sms-messages/attention-summary`, `POST /sms-messages/:id/read`) are
 * `requireRole('admin')` only and a team lead's token never reaches this
 * mapper for one. So once a caller is allowed to see a message at all, they
 * may see the whole of it.
 */

export interface SmsMessageResponse {
  readonly id: string;
  readonly referralId: string | null;
  readonly kind: string;
  readonly phone: string;
  readonly body: string;
  readonly occurredAt: string;
  readonly readAt: string | null;
  /**
   * True when this message was never actually sent through TheSMSWorks — the
   * environment's dev/test simulator, or a destination outside its one live
   * test number. Always false in production. Meaningless on a `failure`
   * (nothing was sent either way) and a `household_reply` (always real).
   */
  readonly simulated: boolean;
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
    simulated: message.simulated,
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
  /**
   * How many of `reminded` never actually reached TheSMSWorks — this
   * environment's dev/test simulator, or a destination outside its one live
   * test number. A subset of `reminded`, not a fourth outcome: a simulated
   * send still counts as a reminder sent. Always `0` in production. See
   * `SmsMessage.simulated`.
   */
  readonly simulated: number;
}

/** The one number the admin inbox screen makes prominent. */
export interface SmsAttentionSummaryResponse {
  readonly unreadTotal: number;
}

export function toAttentionSummaryResponse(unreadTotal: number): SmsAttentionSummaryResponse {
  return { unreadTotal };
}

/**
 * Where a message sits, for the admin inbox to decide what it can do with it:
 *
 * - `unmatched` — no session snapshot. The only location with a `phone`,
 *   because it is the only one with nothing else to act on it by.
 * - `active_session` — the session it was snapshotted against is still
 *   `planned` or `in_progress`. A team leader's business: excluded from
 *   `SmsAttentionSummary`, and `POST /sms-messages/:id/read` refuses to
 *   clear one — opened (and marked read) through the referral's own thread
 *   instead.
 * - `closed_session` — the session has since gone to `confirmed` or
 *   `cancelled`. Nobody is running that session's screen any more, so this is
 *   what makes it an administrator's job.
 */
export type SmsMessageLocation = 'unmatched' | 'active_session' | 'closed_session';

export interface SmsInboxSession {
  readonly id: string;
  readonly sessionDate: string;
  readonly startTime: string;
  readonly status: SessionStatus;
}

export interface SmsInboxMessageResponse {
  readonly id: string;
  readonly referralId: string | null;
  readonly kind: string;
  readonly body: string;
  readonly occurredAt: string;
  readonly readAt: string | null;
  readonly location: SmsMessageLocation;
  readonly session: SmsInboxSession | null;
  readonly phone?: string;
  /** See `SmsMessageResponse.simulated`. */
  readonly simulated: boolean;
}

export function toInboxMessageResponse(row: {
  message: SmsMessage;
  session: Session | null;
}): SmsInboxMessageResponse {
  const { message, session } = row;

  if (session === null) {
    return {
      id: message.id,
      referralId: message.referralId,
      kind: message.kind,
      body: message.body,
      occurredAt: message.occurredAt,
      readAt: message.readAt,
      location: 'unmatched',
      session: null,
      phone: message.phone,
      simulated: message.simulated,
    };
  }

  const location: SmsMessageLocation =
    session.status === 'planned' || session.status === 'in_progress'
      ? 'active_session'
      : 'closed_session';

  return {
    id: message.id,
    referralId: message.referralId,
    kind: message.kind,
    body: message.body,
    occurredAt: message.occurredAt,
    readAt: message.readAt,
    location,
    session: {
      id: session.id,
      sessionDate: session.sessionDate,
      startTime: session.startTime,
      status: session.status,
    },
    simulated: message.simulated,
    // Deliberately no phone here — a linked-session row has a referral to open; only an
    // unmatched reply has nothing else to act on it by. See INITIAL_SPEC1.txt / API.md.
  };
}
