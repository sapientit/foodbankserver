import type { SmsMessage, SmsRecipientRole } from '../../db/schema/sms.ts';
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
 *
 * **A `referrer_reply` reaches only the admin routes above, structurally.**
 * It always has `referralId: null` — see `db/schema/sms.ts` — and the team
 * lead-reachable routes (`GET /referrals/:id/sms-messages`, `POST
 * /referrals/:id/sms-messages`) are queries scoped to one `referralId`, so a
 * `referrer_reply` row cannot be returned by them whatever this mapper does.
 * `toSmsMessageResponse`, which those routes use, therefore carries no
 * `candidateParcels` field at all — there is nothing that role split needs to
 * hide.
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
   * Whose number `phone` actually is. `null` on a genuinely loose reply —
   * nothing to derive it from. A `referrer_reply` can never reach this
   * mapper: it always has `referralId: null`, and every route this mapper
   * serves is scoped to one referral's own thread. See `sms.mapper.ts`'s
   * module comment and `SmsCandidateParcel`.
   */
  readonly recipientRole: SmsRecipientRole | null;
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
    recipientRole: message.recipientRole,
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

/**
 * The four counts the admin inbox screen makes prominent. `activeSessionUnread`
 * is the team leader's business, shown so an administrator can see it without
 * it being their own job; `closedSessionUnread`, `unmatchedUnread` and
 * `referrerUnread` are what administrators are actually told needs doing.
 * `referrerUnread` is kept apart from `unmatchedUnread` even though both are
 * sessionless — a referrer message is never a household's own reply, loose or
 * otherwise, and is never treated as one.
 */
export interface SmsAttentionSummaryResponse {
  readonly activeSessionUnread: number;
  readonly closedSessionUnread: number;
  readonly unmatchedUnread: number;
  readonly referrerUnread: number;
}

export function toAttentionSummaryResponse(counts: {
  readonly activeSessionUnread: number;
  readonly closedSessionUnread: number;
  readonly unmatchedUnread: number;
  readonly referrerUnread: number;
}): SmsAttentionSummaryResponse {
  return {
    activeSessionUnread: counts.activeSessionUnread,
    closedSessionUnread: counts.closedSessionUnread,
    unmatchedUnread: counts.unmatchedUnread,
    referrerUnread: counts.referrerUnread,
  };
}

/**
 * Where a message sits, for the admin inbox to decide what it can do with it:
 *
 * - `unmatched` — no session snapshot. The only location with a `phone`,
 *   because it is the only one with nothing else to act on it by.
 * - `active_session` — the session it was snapshotted against is still
 *   `planned` or `in_progress` **and its own calendar date has not passed**.
 *   A team leader's business: excluded from `SmsAttentionSummary`, and
 *   `POST /sms-messages/:id/read` refuses to clear one — opened (and marked
 *   read) through the referral's own thread instead.
 * - `closed_session` — the session has since gone to `confirmed` or
 *   `cancelled`, **or its date has simply passed**, whichever comes first.
 *   Nobody is running that session's screen any more once either is true —
 *   a session nobody ever got round to formally confirming does not stay
 *   the team leader's business forever just because its status never
 *   moved — so this is what makes it an administrator's job.
 */
export type SmsMessageLocation = 'unmatched' | 'active_session' | 'closed_session';

/** The two statuses that close a session outright, regardless of its date. */
const CLOSED_SESSION_STATUSES: readonly SessionStatus[] = ['confirmed', 'cancelled'];

/**
 * A session counts as closed once it is confirmed or cancelled, or once its
 * own London calendar date has passed, whichever comes first — see
 * `SmsMessageLocation`. `sms.repository.ts`'s `countUnreadByLocation` applies
 * the identical rule in SQL, since a query can't call this function; keep
 * the two in sync by hand if this one changes.
 */
export function isSessionClosed(
  session: { readonly status: SessionStatus; readonly sessionDate: string },
  today: string,
): boolean {
  return CLOSED_SESSION_STATUSES.includes(session.status) || session.sessionDate < today;
}

export interface SmsInboxSession {
  readonly id: string;
  readonly sessionDate: string;
  readonly startTime: string;
  readonly status: SessionStatus;
}

/**
 * One of a referrer's currently open `referrer_collect` parcels, for an
 * administrator to tell a `referrer_reply` apart by. No name, no address, no
 * reason — `INITIAL_SPEC1.txt`, "SMS reminders and replies" is explicit that
 * a referrer message carries nothing about the household beyond what
 * identifies which one it might be.
 */
export interface SmsCandidateParcel {
  readonly referralId: string;
  readonly sessionId: string;
  readonly sessionDate: string;
  readonly startTime: string;
}

export interface SmsInboxMessageResponse {
  readonly id: string;
  readonly referralId: string | null;
  readonly kind: string;
  readonly body: string;
  readonly occurredAt: string;
  readonly readAt: string | null;
  readonly recipientRole: SmsRecipientRole | null;
  readonly location: SmsMessageLocation;
  readonly session: SmsInboxSession | null;
  /**
   * Present only on a `kind: 'referrer_reply'` row — every currently open
   * `referrer_collect` referral for the referrer this message came from,
   * computed fresh by `sms.service.ts`'s `listInbox` rather than stored, so
   * it never goes stale as a candidate referral closes. Absent, not an empty
   * array, on every other kind.
   */
  readonly candidateParcels?: readonly SmsCandidateParcel[] | undefined;
  /**
   * On every row, not only `unmatched` ones. `listInbox` now returns a
   * phone number's whole history in one call rather than every retained
   * message — see `sms.repository.ts` — so this is what the client groups
   * a number's rows into a thread by, session-linked or not.
   *
   * `null` means the household had no number on file — `sms.service.ts`'s
   * `attemptReminder` writes that as `''`, a sentinel rather than a real
   * shared number, and two unconnected households with no number would
   * otherwise look like the same phone number to a client grouping by this
   * field. A `null`-phone row is never grouped with another; use `referralId`
   * for it instead.
   */
  readonly phone: string | null;
  /** See `SmsMessageResponse.simulated`. */
  readonly simulated: boolean;
}

/** `''` is `attemptReminder`'s sentinel for "no number on file" — see `SmsInboxMessageResponse.phone`. */
function inboxPhone(phone: string): string | null {
  return phone === '' ? null : phone;
}

export function toInboxMessageResponse(
  row: {
    message: SmsMessage;
    session: Session | null;
  },
  today: string,
  candidateParcels?: readonly SmsCandidateParcel[],
): SmsInboxMessageResponse {
  const { message, session } = row;
  // Spread rather than assigned: absent on every kind but `referrer_reply`,
  // not an empty array a client would have to tell apart from "computed and
  // found nothing".
  const candidates =
    message.kind === 'referrer_reply' && candidateParcels !== undefined ? { candidateParcels } : {};

  if (session === null) {
    return {
      id: message.id,
      referralId: message.referralId,
      kind: message.kind,
      body: message.body,
      occurredAt: message.occurredAt,
      readAt: message.readAt,
      recipientRole: message.recipientRole,
      location: 'unmatched',
      session: null,
      phone: inboxPhone(message.phone),
      simulated: message.simulated,
      ...candidates,
    };
  }

  const location: SmsMessageLocation = isSessionClosed(session, today)
    ? 'closed_session'
    : 'active_session';

  return {
    id: message.id,
    referralId: message.referralId,
    kind: message.kind,
    body: message.body,
    occurredAt: message.occurredAt,
    readAt: message.readAt,
    recipientRole: message.recipientRole,
    location,
    session: {
      id: session.id,
      sessionDate: session.sessionDate,
      startTime: session.startTime,
      status: session.status,
    },
    phone: inboxPhone(message.phone),
    simulated: message.simulated,
    ...candidates,
  };
}
