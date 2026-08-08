import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { NotFoundError, UnprocessableError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import type { Referral } from '../../db/schema/referrals.ts';
import type { Session } from '../../db/schema/sessions.ts';
import type { SmsMessage } from '../../db/schema/sms.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import { normalisePhone, phonesMatch } from '../../core/phone.ts';
import { composeReminder } from './messages.ts';
import { sendSms, type SmsProviderConfig } from './provider.ts';
import type { WebhookInboundMessage } from './sms.schema.ts';
import type { SmsRepository } from './sms.repository.ts';
import type {
  SmsHouseholdSummary,
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
   * row — the same outcome a bad number produces — so the feature is fully
   * exercisable end to end without one. See `config/env.ts`.
   */
  readonly provider: SmsProviderConfig | undefined;
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
    }
  | {
      readonly referralId: string;
      readonly success: false;
      readonly phone: string;
      readonly body: string;
    };

export function createSmsService(deps: SmsServiceDeps) {
  const { db, repository, sessions, clock, logger, provider } = deps;

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
      return { sessionId, reminded: 0, failed: 0, alreadyReminded };
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

    for (const outcome of outcomes) {
      statements.push(
        repository.buildInsertMessage({
          id: crypto.randomUUID(),
          referralId: outcome.referralId,
          kind: outcome.success ? 'reminder' : 'failure',
          phone: outcome.phone,
          body: outcome.body,
          providerMessageId: outcome.success ? outcome.providerMessageId : null,
          occurredAt: now,
          // Outbound and failures are read on arrival — only a household_reply is ever unread.
          readAt: now,
          sentByUserId: actor.userId,
          createdAt: now,
          updatedAt: now,
        }),
      );

      if (outcome.success) {
        statements.push(repository.buildMarkReminderSent(outcome.referralId, now));
        sentCount += 1;
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
    };
  }

  async function attemptReminder(referral: Referral, session: Session): Promise<ReminderOutcome> {
    if (referral.refereePhone === null) {
      return {
        referralId: referral.id,
        success: false,
        phone: '',
        body: 'No phone number on file',
      };
    }

    const normalised = normalisePhone(referral.refereePhone);
    if (normalised === null) {
      return {
        referralId: referral.id,
        success: false,
        phone: referral.refereePhone,
        body: 'The number on file could not be recognised',
      };
    }

    if (provider === undefined) {
      return {
        referralId: referral.id,
        success: false,
        phone: normalised,
        body: 'SMS sending is not configured',
      };
    }

    const content = composeReminder(session, referral.isDelivery === 1);
    const result = await sendSms(provider, normalised, content, logger);

    if (!result.ok) {
      return {
        referralId: referral.id,
        success: false,
        phone: normalised,
        body: `Send failed: ${result.reason}`,
      };
    }

    return {
      referralId: referral.id,
      success: true,
      phone: normalised,
      body: content,
      providerMessageId: result.providerMessageId,
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

    const normalised =
      referral.refereePhone === null ? null : normalisePhone(referral.refereePhone);
    if (normalised === null) {
      throw new UnprocessableError('This household has no number to reply to');
    }
    if (provider === undefined) {
      throw new UnprocessableError('SMS sending is not configured');
    }

    const result = await sendSms(provider, normalised, body, logger);
    if (!result.ok) {
      throw new UnprocessableError('The reply could not be sent. Please try again.');
    }

    const now = clock.nowIso();
    const message = await repository.insert({
      id: crypto.randomUUID(),
      referralId,
      kind: 'staff_reply',
      phone: normalised,
      body,
      providerMessageId: result.providerMessageId,
      occurredAt: now,
      readAt: now, // Outbound — read on arrival, like a reminder or a failure.
      sentByUserId: actor.userId,
      createdAt: now,
      updatedAt: now,
    });

    logger.info('staff sms reply sent', { referralId, userId: actor.userId });
    return message;
  }

  /**
   * A household's reply, matched by phone to the referral for the soonest
   * session still to come. No match keeps the row as a loose reply.
   *
   * **Idempotent against a retried webhook.** TheSMSWorks retries a delivery
   * it did not get a `200` for, so the same `providerMessageId` can arrive
   * twice; the unique index catches the second insert and this reports
   * success rather than a duplicate row.
   */
  async function receiveInbound(payload: WebhookInboundMessage): Promise<void> {
    const now = clock.nowIso();
    const referralId = await matchReferral(payload.phone, now);
    // Store whatever normalised form is available; an unnormalisable number
    // is still kept exactly as the provider sent it, same as a failure row.
    const phone = normalisePhone(payload.phone) ?? payload.phone;

    try {
      await repository.insert({
        id: crypto.randomUUID(),
        referralId,
        kind: 'household_reply',
        phone,
        body: payload.body,
        providerMessageId: payload.providerMessageId,
        occurredAt: now,
        readAt: null, // The only kind that is ever unread.
        sentByUserId: null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (
        payload.providerMessageId !== null &&
        isUniqueViolation(error, 'sms_messages.provider_message_id')
      ) {
        logger.info('duplicate sms webhook delivery', {});
        return;
      }
      throw error;
    }

    logger.info('sms received', referralId === null ? {} : { referralId });
  }

  async function matchReferral(rawPhone: string, nowUtc: string): Promise<string | null> {
    const candidates = await repository.referralsOnUpcomingSessions(nowUtc);
    for (const { referral } of candidates) {
      if (referral.refereePhone !== null && phonesMatch(referral.refereePhone, rawPhone)) {
        return referral.id;
      }
    }
    return null;
  }

  /** Loose replies — admin only, enforced at the route. */
  async function listUnmatched(): Promise<SmsMessage[]> {
    return repository.listUnmatched();
  }

  /**
   * Marks one loose reply read. Scoped to loose replies deliberately: a
   * matched message is marked read by opening its referral's thread instead,
   * so applying this to one reports it as not found, the same way a team
   * lead is refused a rejected referral by name.
   */
  async function markUnmatchedRead(id: string): Promise<SmsMessage> {
    const message = await repository.findById(id);
    if (message?.referralId !== null) {
      throw new NotFoundError('Message not found');
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
    markUnmatchedRead,
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
