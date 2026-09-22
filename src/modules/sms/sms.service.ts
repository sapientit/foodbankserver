import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { NotFoundError, UnprocessableError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import type { Referral } from '../../db/schema/referrals.ts';
import type { Session } from '../../db/schema/sessions.ts';
import type { SmsMessage, SmsRecipientRole } from '../../db/schema/sms.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import { normalisePhone, phonesMatch } from '../../core/phone.ts';
import { instantToLondonWallClock } from '../../core/time/london.ts';
import { composeReferrerReminder, composeReminder } from './messages.ts';
import { sendSms, type SmsProviderConfig } from './provider.ts';
import { smsRetentionCutoffIso } from './retention.ts';
import type { WebhookInboundMessage } from './sms.schema.ts';
import type { SmsRepository } from './sms.repository.ts';
import {
  isSessionClosed,
  toAttentionSummaryResponse,
  toInboxMessageResponse,
  type SmsCandidateParcel,
} from './sms.mapper.ts';
import type {
  SmsAttentionSummaryResponse,
  SmsHouseholdSummary,
  SmsInboxMessageResponse,
  SmsSendResultResponse,
  SmsSessionSummaryResponse,
} from './sms.mapper.ts';

export interface SmsServiceDeps {
  readonly db: Database;
  readonly repository: SmsRepository;
  readonly sessions: SessionsRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * `undefined` when `SMS_API_KEY` or `SMS_SENDER` is not configured.
   *
   * Development and CI run without a provider account. Rather than refusing
   * to send, an absent provider makes every attempted household a `failure`
   * row — the same outcome a bad number produces — unless `simulate` is on.
   * See `config/env.ts`.
   */
  readonly provider: SmsProviderConfig | undefined;
  /**
   * Fakes a successful send for any destination that is not going to be
   * really sent — see `liveNumber` — instead of recording a `failure`. The
   * dev/test simulator: exercises the success path (thread, counts,
   * `smsReminderSentAt`) with no provider account at all. `SMS_SIMULATE`,
   * refused in production.
   */
  readonly simulate: boolean;
  /**
   * When set, only this one destination is ever actually handed to
   * `sendSms`; every other destination falls through to `simulate` (or to a
   * `failure`, if that is also off). Lets a staging environment run against
   * a real TheSMSWorks account without texting real households from a copy
   * of live referral data. `SMS_LIVE_NUMBER`, refused in production.
   */
  readonly liveNumber: string | undefined;
}

/** Outbound fetches in flight at once, so a session of 25+ does not open 25+ concurrent requests. */
const SEND_CONCURRENCY = 5;

type ReminderOutcome =
  | {
      readonly referralId: string;
      readonly success: true;
      readonly phone: string;
      readonly body: string;
      readonly providerMessageId: string;
      readonly simulated: boolean;
      readonly recipientRole: SmsRecipientRole;
    }
  | {
      readonly referralId: string;
      readonly success: false;
      readonly phone: string;
      readonly body: string;
      readonly recipientRole: SmsRecipientRole | null;
    };

/**
 * Who a parcel-related message goes to, and whose number that is —
 * `INITIAL_SPEC1.txt`, "SMS reminders and replies": a `referrer_collect`
 * referral is texted on the referrer's own number, never the referee's.
 * `null` phone means there is nothing on file for the role this referral
 * actually uses, which `attemptReminder`/`sendStaffReply` report exactly as
 * they already did for a missing `refereePhone`.
 */
function recipientFor(referral: Referral): { phone: string | null; role: SmsRecipientRole } {
  if (referral.collectionMethod === 'referrer_collect') {
    return { phone: referral.referrerPhone, role: 'referrer' };
  }
  return { phone: referral.refereePhone, role: 'referee' };
}

const NOT_CONFIGURED_REASON = 'SMS sending is not configured';
const RESTRICTED_REASON = 'SMS sending is restricted to a test number in this environment';

export function createSmsService(deps: SmsServiceDeps) {
  const { db, repository, sessions, clock, logger, provider, simulate, liveNumber } = deps;

  /** Unrestricted when no `liveNumber` is set — see `SmsServiceDeps.liveNumber`. */
  function isLive(destination: string): boolean {
    return liveNumber === undefined || phonesMatch(destination, liveNumber);
  }

  function simulatedProviderMessageId(): string {
    return `sim-${crypto.randomUUID()}`;
  }

  /**
   * Sends a reminder to every household on the session holding a place that
   * has not already been sent one.
   *
   * **Send first, then write.** Every outcome — success, a bad number, no
   * number, or the provider refusing — is collected in memory across up to
   * `SEND_CONCURRENCY` fetches at once, and only then does a single
   * `db.batch()` write every message row and flip every flag that succeeded.
   * A statement per household would blow the query budget on a session of
   * any size; a batch per household would blow the D1 batch-per-invocation
   * budget the same way.
   */
  async function sendReminders(sessionId: string, actor: Actor): Promise<SmsSendResultResponse> {
    const session = await sessions.findById(sessionId);
    if (session === undefined) {
      throw new NotFoundError('Session not found');
    }

    // One read, partitioned in memory, rather than a second query to count the
    // households that were already done — the screen needs both numbers and
    // this is the endpoint a team leader presses with 25 referrals loaded.
    const households = await repository.referralsHoldingAPlace(sessionId);
    const candidates = households.filter((referral) => referral.smsReminderSentAt === null);
    const alreadyReminded = households.length - candidates.length;

    if (candidates.length === 0) {
      return { sessionId, reminded: 0, failed: 0, alreadyReminded, simulated: 0 };
    }

    const now = clock.nowIso();
    const outcomes = await mapWithConcurrency(candidates, SEND_CONCURRENCY, (referral) =>
      attemptReminder(referral, session),
    );

    const statements: (
      | ReturnType<SmsRepository['buildInsertMessage']>
      | ReturnType<SmsRepository['buildMarkReminderSent']>
    )[] = [];
    let sentCount = 0;
    let simulatedCount = 0;

    for (const outcome of outcomes) {
      statements.push(
        repository.buildInsertMessage({
          id: crypto.randomUUID(),
          referralId: outcome.referralId,
          sessionId: session.id,
          kind: outcome.success ? 'reminder' : 'failure',
          phone: outcome.phone,
          body: outcome.body,
          providerMessageId: outcome.success ? outcome.providerMessageId : null,
          occurredAt: now,
          // Outbound and failures are read on arrival — only a household_reply is ever unread.
          readAt: now,
          sentByUserId: actor.userId,
          recipientRole: outcome.recipientRole,
          simulated: outcome.success && outcome.simulated,
          createdAt: now,
          updatedAt: now,
        }),
      );

      if (outcome.success) {
        statements.push(repository.buildMarkReminderSent(outcome.referralId, now));
        sentCount += 1;
        if (outcome.simulated) {
          simulatedCount += 1;
        }
      }
    }

    // Drizzle's `batch` wants a non-empty tuple. Narrow to one rather than
    // asserting it: `candidates.length > 0` guarantees the first insert exists,
    // but a cast would keep compiling if that guarantee ever moved.
    const [first, ...rest] = statements;
    if (first !== undefined) {
      await db.batch([first, ...rest]);
    }

    logger.info('sent sms reminders', {
      sessionId,
      count: sentCount,
      userId: actor.userId,
    });

    return {
      sessionId,
      reminded: sentCount,
      failed: candidates.length - sentCount,
      alreadyReminded,
      simulated: simulatedCount,
    };
  }

  async function attemptReminder(referral: Referral, session: Session): Promise<ReminderOutcome> {
    const recipient = recipientFor(referral);
    if (recipient.phone === null) {
      return {
        referralId: referral.id,
        success: false,
        phone: '',
        body: 'No phone number on file',
        recipientRole: recipient.role,
      };
    }

    const normalised = normalisePhone(recipient.phone);
    if (normalised === null) {
      return {
        referralId: referral.id,
        success: false,
        phone: recipient.phone,
        body: 'The number on file could not be recognised',
        recipientRole: recipient.role,
      };
    }

    // A referrer_collect message never reuses the household's own wording —
    // it is composed for the referrer, on the referrer's own name.
    const content =
      recipient.role === 'referrer'
        ? composeReferrerReminder(session, referral.referrerName)
        : composeReminder(session, referral.isDelivery === 1, referral.refereeFirstName);

    if (provider !== undefined && isLive(normalised)) {
      const result = await sendSms(provider, normalised, content, logger);
      if (!result.ok) {
        return {
          referralId: referral.id,
          success: false,
          phone: normalised,
          body: `Send failed: ${result.reason}`,
          recipientRole: recipient.role,
        };
      }
      return {
        referralId: referral.id,
        success: true,
        phone: normalised,
        body: content,
        providerMessageId: result.providerMessageId,
        simulated: false,
        recipientRole: recipient.role,
      };
    }

    if (simulate) {
      return {
        referralId: referral.id,
        success: true,
        phone: normalised,
        body: content,
        providerMessageId: simulatedProviderMessageId(),
        simulated: true,
        recipientRole: recipient.role,
      };
    }

    return {
      referralId: referral.id,
      success: false,
      phone: normalised,
      body: provider === undefined ? NOT_CONFIGURED_REASON : RESTRICTED_REASON,
      recipientRole: recipient.role,
    };
  }

  /** The counts and per-household state the run-session screen shows. */
  async function summaryForSession(sessionId: string): Promise<SmsSessionSummaryResponse> {
    const session = await sessions.findById(sessionId);
    if (session === undefined) {
      throw new NotFoundError('Session not found');
    }

    const households = await repository.referralsHoldingAPlace(sessionId);
    const counts = await repository.inboundCountsFor(households.map((referral) => referral.id));

    const summaries: SmsHouseholdSummary[] = households.map((referral) => {
      const forReferral = counts.get(referral.id) ?? { messageCount: 0, unreadCount: 0 };
      return {
        referralId: referral.id,
        sent: referral.smsReminderSentAt !== null,
        messageCount: forReferral.messageCount,
        unreadCount: forReferral.unreadCount,
      };
    });

    return {
      sessionId,
      unreadTotal: summaries.reduce((total, household) => total + household.unreadCount, 0),
      households: summaries,
    };
  }

  /** The whole conversation for a household. Read-only — see `sms.routes.ts`. */
  async function getThread(referralId: string): Promise<SmsMessage[]> {
    await requireReferral(referralId);
    return repository.threadForReferral(referralId);
  }

  /** Marks a household's inbound messages read. The separate action `getThread` does not do itself. */
  async function markThreadRead(referralId: string): Promise<void> {
    await requireReferral(referralId);
    await repository.markThreadRead(referralId, clock.nowIso());
  }

  /**
   * Staff texting a household back.
   *
   * Unlike a reminder, there is no `failure` kind for a staff reply — the
   * message either went, and is recorded, or it did not, and nothing is
   * written that claims it did. A provider failure here is surfaced as an
   * error to the person who pressed send rather than absorbed into the
   * household's timeline.
   */
  async function sendStaffReply(
    referralId: string,
    body: string,
    actor: Actor,
  ): Promise<SmsMessage> {
    const referral = await requireReferral(referralId);

    const recipient = recipientFor(referral);
    const normalised = recipient.phone === null ? null : normalisePhone(recipient.phone);
    if (normalised === null) {
      throw new UnprocessableError(
        recipient.role === 'referrer'
          ? 'This referral has no referrer number to reply to'
          : 'This household has no number to reply to',
      );
    }

    let providerMessageId: string;
    let simulated: boolean;

    if (provider !== undefined && isLive(normalised)) {
      const result = await sendSms(provider, normalised, body, logger);
      if (!result.ok) {
        throw new UnprocessableError('The reply could not be sent. Please try again.');
      }
      providerMessageId = result.providerMessageId;
      simulated = false;
    } else if (simulate) {
      providerMessageId = simulatedProviderMessageId();
      simulated = true;
    } else {
      throw new UnprocessableError(
        provider === undefined ? NOT_CONFIGURED_REASON : RESTRICTED_REASON,
      );
    }

    const now = clock.nowIso();
    const message = await repository.insert({
      id: crypto.randomUUID(),
      referralId,
      sessionId: referral.sessionId,
      kind: 'staff_reply',
      phone: normalised,
      body,
      providerMessageId,
      occurredAt: now,
      readAt: now, // Outbound — read on arrival, like a reminder or a failure.
      sentByUserId: actor.userId,
      recipientRole: recipient.role,
      simulated,
      createdAt: now,
      updatedAt: now,
    });

    logger.info('staff sms reply sent', { referralId, userId: actor.userId });
    return message;
  }

  /**
   * A household's reply, matched by phone, first, to the referral for the
   * soonest session still to come, then — failing that — to the most recent
   * session that phone was ever referred against, of any age. Only a phone
   * genuinely never referred at all keeps the row as a loose reply. See
   * `matchReferral`.
   *
   * **A referrer match is checked first and, when found, wins outright** —
   * the household matching below is the fallback for a sender **not**
   * identified as an active referrer collector, not a second pass run
   * alongside it. `INITIAL_SPEC1.txt`, "SMS reminders and replies".
   *
   * **Idempotent against a retried webhook.** TheSMSWorks retries a delivery
   * it did not get a `200` for, so the same `providerMessageId` can arrive
   * twice; the unique index catches the second insert and `insertInbound`
   * reports back whether it actually wrote a row, so a retried delivery logs
   * only `'duplicate sms webhook delivery'` rather than also claiming a
   * fresh `'sms received'`.
   */
  async function receiveInbound(payload: WebhookInboundMessage): Promise<void> {
    const now = clock.nowIso();
    // Store whatever normalised form is available; an unnormalisable number
    // is still kept exactly as the provider sent it, same as a failure row.
    const phone = normalisePhone(payload.phone) ?? payload.phone;

    const referrerCandidates = await matchReferrerCollectors(payload.phone, now);
    if (referrerCandidates.length > 0) {
      const inserted = await insertInbound({
        referralId: null,
        sessionId: null,
        kind: 'referrer_reply',
        phone,
        body: payload.body,
        providerMessageId: payload.providerMessageId,
        recipientRole: 'referrer',
        now,
      });
      if (inserted) logger.info('referrer sms received', {});
      return;
    }

    const match = await matchReferral(payload.phone, now);
    const referralId = match?.referralId ?? null;

    const inserted = await insertInbound({
      referralId,
      sessionId: match?.sessionId ?? null,
      kind: 'household_reply',
      phone,
      body: payload.body,
      providerMessageId: payload.providerMessageId,
      recipientRole: match === null ? null : 'referee',
      now,
    });

    if (inserted) logger.info('sms received', referralId === null ? {} : { referralId });
  }

  /**
   * Shared by both inbound branches: the insert itself, plus the retried-
   * webhook idempotency guard neither branch should have to repeat. Returns
   * whether a row was actually written — `false` on a duplicate delivery —
   * so a caller logging "received" does not also claim a duplicate as new.
   */
  async function insertInbound(row: {
    readonly referralId: string | null;
    readonly sessionId: string | null;
    readonly kind: 'household_reply' | 'referrer_reply';
    readonly phone: string;
    readonly body: string;
    readonly providerMessageId: string | null;
    readonly recipientRole: SmsRecipientRole | null;
    readonly now: string;
  }): Promise<boolean> {
    try {
      await repository.insert({
        id: crypto.randomUUID(),
        referralId: row.referralId,
        sessionId: row.sessionId,
        kind: row.kind,
        phone: row.phone,
        body: row.body,
        providerMessageId: row.providerMessageId,
        occurredAt: row.now,
        readAt: null, // The only kinds that are ever unread.
        sentByUserId: null,
        recipientRole: row.recipientRole,
        simulated: false, // No such thing as a simulated inbound row — see the column comment.
        createdAt: row.now,
        updatedAt: row.now,
      });
      return true;
    } catch (error) {
      if (
        row.providerMessageId !== null &&
        isUniqueViolation(error, 'sms_messages.provider_message_id')
      ) {
        logger.info('duplicate sms webhook delivery', {});
        return false;
      }
      throw error;
    }
  }

  /**
   * The referral for the soonest session still to come wins outright, same
   * as always. Failing that, falls back to the single most recent session
   * this phone was ever referred against, of any age or status — a reply
   * to a session that has already happened still has somewhere to land, not
   * only one still open. See `SmsRepository.latestSessionForPhone`.
   */
  async function matchReferral(
    rawPhone: string,
    nowUtc: string,
  ): Promise<{ referralId: string; sessionId: string } | null> {
    const candidates = await repository.referralsOnUpcomingSessions(nowUtc);
    for (const { referral, session } of candidates) {
      if (referral.refereePhone !== null && phonesMatch(referral.refereePhone, rawPhone)) {
        return { referralId: referral.id, sessionId: session.id };
      }
    }

    const normalised = normalisePhone(rawPhone);
    if (normalised === null) return null;
    const latest = await repository.latestSessionForPhone(normalised);
    return latest === null
      ? null
      : { referralId: latest.referral.id, sessionId: latest.session.id };
  }

  /**
   * Filters an already-fetched candidate set to one phone — pure, no I/O.
   * Every caller with more than one phone to check (`listInbox`) must fetch
   * the candidate set **once** and call this per phone, never re-query per
   * phone: `.claude/rules/database.md`, "No N+1, ever".
   */
  function filterReferrerCollectors(
    candidates: readonly { referral: Referral; session: Session }[],
    rawPhone: string,
  ): { referral: Referral; session: Session }[] {
    return candidates.filter(
      ({ referral }) =>
        referral.referrerPhone !== null && phonesMatch(referral.referrerPhone, rawPhone),
    );
  }

  function toCandidateParcel({
    referral,
    session,
  }: {
    referral: Referral;
    session: Session;
  }): SmsCandidateParcel {
    return {
      referralId: referral.id,
      sessionId: session.id,
      sessionDate: session.sessionDate,
      startTime: session.startTime,
    };
  }

  /**
   * Every currently open `referrer_collect` referral whose `referrerPhone`
   * matches, for a given raw phone — plural, deliberately: a referrer may be
   * collecting for several households and on several days, and this is never
   * collapsed to one. **One query, for one phone** — used by `receiveInbound`,
   * which only ever has one phone to check per webhook. `listInbox` fetches
   * the candidate set itself instead, once for every phone it needs, rather
   * than calling this in a loop — see its own comment.
   */
  async function matchReferrerCollectors(
    rawPhone: string,
    nowUtc: string,
  ): Promise<{ referral: Referral; session: Session }[]> {
    const candidates = await repository.referrerCollectReferralsOnUpcomingSessions(nowUtc);
    return filterReferrerCollectors(candidates, rawPhone);
  }

  /** Loose replies — admin only, enforced at the route. */
  async function listUnmatched(): Promise<SmsMessage[]> {
    return repository.listUnmatched();
  }

  /** The four counts the admin inbox screen makes prominent. */
  async function attentionSummary(): Promise<SmsAttentionSummaryResponse> {
    const now = clock.nowIso();
    const cutoff = smsRetentionCutoffIso(now);
    const today = instantToLondonWallClock(now).date;
    const counts = await repository.countUnreadByLocation(cutoff, today);
    return toAttentionSummaryResponse(counts);
  }

  /**
   * The admin inbox: every message within retention, newest first.
   *
   * A `referrer_reply` row gets its candidate parcels computed **fresh here**
   * rather than read off anything stored on the row — see the "currently
   * open" note on `matchReferrerCollectors`. **One query for the whole
   * inbox**, not one per qualifying referrer number: the candidate set does
   * not depend on which phone is asking, so it is fetched once — if there
   * are any `referrer_reply` rows at all — and filtered per phone in memory
   * with `filterReferrerCollectors`. `.claude/rules/database.md`, "No N+1,
   * ever".
   */
  async function listInbox(): Promise<SmsInboxMessageResponse[]> {
    const now = clock.nowIso();
    const cutoff = smsRetentionCutoffIso(now);
    const today = instantToLondonWallClock(now).date;
    const rows = await repository.listInbox(cutoff);

    const hasReferrerReply = rows.some(({ message }) => message.kind === 'referrer_reply');
    const openReferrerCollectors = hasReferrerReply
      ? await repository.referrerCollectReferralsOnUpcomingSessions(now)
      : [];

    const candidatesByPhone = new Map<string, SmsCandidateParcel[]>();
    for (const { message } of rows) {
      if (message.kind !== 'referrer_reply' || candidatesByPhone.has(message.phone)) continue;
      candidatesByPhone.set(
        message.phone,
        filterReferrerCollectors(openReferrerCollectors, message.phone).map(toCandidateParcel),
      );
    }

    return rows.map((row) =>
      toInboxMessageResponse(row, today, candidatesByPhone.get(row.message.phone)),
    );
  }

  /**
   * Clears one inbox item — a loose reply or a reply on a session that has
   * since closed, not only an unmatched one as before. Deliberately refuses
   * a reply still on a session that is not yet closed: that one remains the
   * team leader's to read until the session closes, the same rule
   * `isSessionClosed` uses to keep it out of the attention count, and this
   * endpoint must not give an administrator a side door round it. Scoped to
   * the one row named either way — this never marks a second message.
   */
  async function markMessageRead(id: string): Promise<SmsMessage> {
    const message = await repository.findById(id);
    if (message?.kind !== 'household_reply' && message?.kind !== 'referrer_reply') {
      throw new NotFoundError('Message not found');
    }

    const session =
      message.sessionId === null ? undefined : await sessions.findById(message.sessionId);
    if (session !== undefined) {
      const today = instantToLondonWallClock(clock.nowIso()).date;
      if (!isSessionClosed(session, today)) {
        throw new NotFoundError('Message not found');
      }
    }

    const updated = await repository.markOneRead(id, clock.nowIso());
    if (updated === undefined) {
      throw new NotFoundError('Message not found');
    }
    return updated;
  }

  async function requireReferral(referralId: string): Promise<Referral> {
    const referral = await repository.findReferralById(referralId);
    if (referral === undefined) {
      throw new NotFoundError('Referral not found');
    }
    return referral;
  }

  return {
    sendReminders,
    summaryForSession,
    getThread,
    markThreadRead,
    sendStaffReply,
    receiveInbound,
    listUnmatched,
    markMessageRead,
    attentionSummary,
    listInbox,
  };
}

export type SmsService = ReturnType<typeof createSmsService>;

/**
 * Runs `fn` over `items` with at most `limit` calls in flight, preserving
 * result order. Pure orchestration — no Worker API depends on a specific
 * concurrency primitive here, so a small hand-written pool is simpler than a
 * dependency for five lines of logic.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
