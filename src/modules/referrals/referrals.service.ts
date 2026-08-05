import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Patch } from '../../core/types.ts';
import type { Database } from '../../db/client.ts';
import type { NewReferral, Referral } from '../../db/schema/referrals.ts';
import type { ReferrersRepository } from '../referrers/referrers.repository.ts';
import type { ReferrersService } from '../referrers/referrers.service.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import type { ReferralListFilter, ReferralsRepository } from './referrals.repository.ts';
import type { ReferralAmend, ReferralSubmission } from './referrals.schema.ts';

export interface ReferralsServiceDeps {
  readonly db: Database;
  readonly repository: ReferralsRepository;
  readonly sessions: SessionsRepository;
  readonly referrers: ReferrersRepository;
  readonly referrersService: ReferrersService;
  readonly clock: Clock;
  readonly logger: Logger;
}

export function createReferralsService(deps: ReferralsServiceDeps) {
  const { db, repository, sessions, referrers, referrersService, clock, logger } = deps;

  async function getReferral(id: string): Promise<Referral> {
    const referral = await repository.findById(id);
    if (referral === undefined) {
      throw new NotFoundError('Referral not found');
    }
    return referral;
  }

  /**
   * The same read, narrowed to what the caller is allowed to know exists.
   *
   * **A team lead sees a pending referral but not a rejected one.** A pending
   * referral is a household that may well turn up, and the lead is the person
   * standing in the hall when they do — being unable to answer "am I expecting
   * the Robinsons?" helps nobody. A rejected one is not their concern, and the
   * reason it was rejected lives in `reviewComment`, which is admin-only; the
   * screen could show the refusal without ever being able to explain it.
   *
   * `404`, not `403`: a team lead has no business learning that a rejected
   * referral exists, and a refusal that distinguishes the two says so.
   */
  async function viewReferral(id: string, actor: Actor): Promise<Referral> {
    const referral = await getReferral(id);
    if (referral.status === 'rejected' && actor.role !== 'admin') {
      throw new NotFoundError('Referral not found');
    }
    return referral;
  }

  /** The list, with the same visibility rule applied in SQL. */
  async function listReferrals(filter: ReferralListFilter, actor: Actor): Promise<Referral[]> {
    if (actor.role === 'admin') return repository.list(filter);

    // A team lead asking for rejected referrals by name gets an empty list
    // rather than an error: the status simply is not one of theirs.
    if (filter.status === 'rejected') return [];
    return repository.list({ ...filter, excludeStatuses: ['rejected'] });
  }

  /**
   * A session that can still take a referral.
   *
   * `allowOverCapacity` exists because an admin may deliberately overfill a
   * session when moving someone — the spec's "even if that exceeds capacity,
   * with a warning". The public flow never sets it.
   *
   * Note there is deliberately **no** conditional-insert guard here. The
   * capacity check is a read followed by a write, so two simultaneous
   * submissions could both pass it and produce a 26th referral. That race was
   * explicitly accepted: an occasional extra household is harmless, and the
   * single-statement guard that would prevent it moves the rule out of this
   * service and into SQL.
   */
  async function assertSessionAccepts(
    sessionId: string,
    allowOverCapacity: boolean,
  ): Promise<void> {
    const session = await sessions.findById(sessionId);
    if (session === undefined) {
      throw new NotFoundError('Session not found');
    }
    if (session.status === 'cancelled') {
      throw new ConflictError('That session has been cancelled');
    }
    if (session.status === 'confirmed') {
      throw new ConflictError('That session has already been confirmed');
    }
    if (allowOverCapacity) return;

    const booked = await repository.countHoldingAPlace(sessionId);
    if (booked >= session.capacity) {
      throw new ConflictError('That session is full', {
        details: { capacity: session.capacity, booked },
      });
    }
  }

  /**
   * Submits a referral. Unauthenticated.
   *
   * **An unrecognised referrer is not refused.** The address is still checked,
   * but the answer decides the *status* rather than whether the referral is
   * taken at all: a recognised address is `active` immediately, an unrecognised
   * one waits as `pending_review` for an administrator to accept or reject it.
   * The charity would rather look at a referral it did not expect than turn
   * away a household that needs feeding.
   *
   * Two gates remain, cheapest first: the session must be open and not full,
   * and the reason must still be offered. Both apply to a pending referral too,
   * because a pending referral holds its place on the session.
   *
   * The dynamic answers are **not** a third gate. The referral form is client
   * configuration, so the server holds no definition to check them against and
   * stores what it is given.
   */
  async function submit(input: ReferralSubmission): Promise<Referral> {
    const authorisation = await referrersService.checkAuthorisation(input.referrerEmail);

    await assertSessionAccepts(input.sessionId, false);

    const reason = await referrers.findActiveReasonById(input.reasonId);
    if (reason === undefined) {
      throw new UnprocessableError('That reason for referral is no longer offered');
    }

    const now = clock.nowIso();
    const referralId = crypto.randomUUID();

    const referral: NewReferral = {
      id: referralId,
      sessionId: input.sessionId,
      status: authorisation.authorised ? 'active' : 'pending_review',
      referredAt: now,
      cancelledAt: null,
      cancelledReason: null,
      reviewComment: null,
      reviewedByUserId: null,
      // Taken from the submission, because an unrecognised referrer has no row
      // to derive it from. The matched id below is still the server's own, so a
      // submitted string never decides which organisation gets the credit.
      referrerOrganisation: input.referrerOrganisation,
      authorisedReferrerId: authorisation.matchedId,
      adults: input.adults,
      children: input.children,
      isDelivery: input.isDelivery ? 1 : 0,
      reasonId: input.reasonId,
      needsFuelHelp: input.needsFuelHelp ? 1 : 0,
      referrerName: input.referrerName,
      referrerEmail: input.referrerEmail.trim().toLowerCase(),
      referrerPhone: input.referrerPhone ?? null,
      refereeFirstName: input.refereeFirstName,
      refereeSurname: input.refereeSurname,
      refereeDateOfBirth: input.refereeDateOfBirth,
      refereeAddress: input.refereeAddress,
      refereePostcode: input.refereePostcode,
      refereePhone: input.refereePhone ?? null,
      answersJson: JSON.stringify(input.answers),
      piiPurgedAt: null,
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
    };

    // Referral and audit entry in one batch — there is no transaction, and a
    // referral nobody can account for is worse than no referral.
    await db.batch([
      repository.buildInsertReferral(referral),
      repository.buildAudit({
        id: crypto.randomUUID(),
        occurredAt: now,
        actorKind: 'anonymous',
        actorUserId: null,
        entityType: 'referral',
        entityId: referralId,
        action: 'created',
        detailJson: null,
      }),
    ]);

    logger.info('referral submitted', { referralId, sessionId: input.sessionId });

    return getReferral(referralId);
  }

  /**
   * Accepts or rejects a referral that is waiting to be looked at.
   *
   * Only from `pending_review`: reviewing an active referral would be a way of
   * quietly reinstating a cancelled one, and reviewing a rejected one twice
   * says nothing new. The comment is overwritten rather than appended — the
   * charity asked for one line per review, not a history.
   *
   * The "still pending" check is **in the statement, not here**. Checking it in
   * TypeScript first would be a read-then-write on a database with no
   * interactive transactions, so two administrators working the same queue
   * could both pass it and the second would silently overwrite the first — an
   * accept undoing a reject with nobody told.
   */
  async function review(
    referralId: string,
    outcome: 'active' | 'rejected',
    comment: string | null,
    actor: Actor,
  ): Promise<Referral> {
    const now = clock.nowIso();
    const updated = await repository.reviewIfPending(referralId, {
      status: outcome,
      reviewComment: comment,
      reviewedByUserId: actor.userId,
      updatedAt: now,
    });

    if (updated === undefined) {
      // Nothing matched: either there is no such referral, or it is no longer
      // pending. Tell those two apart so an admin is not sent chasing a ghost.
      await getReferral(referralId);
      throw new ConflictError('That referral is not waiting to be reviewed');
    }

    await repository.recordAudit({
      id: crypto.randomUUID(),
      occurredAt: now,
      actorKind: 'user',
      actorUserId: actor.userId,
      entityType: 'referral',
      entityId: referralId,
      action: outcome === 'active' ? 'accepted' : 'rejected',
      detailJson: null,
    });

    logger.info('referral reviewed', { referralId, userId: actor.userId });
    return updated;
  }

  /**
   * A referral that is finished with cannot be changed.
   *
   * Shared by amending and moving because `PATCH /referrals/{id}` does both,
   * and refusing one while allowing the other on the same object is incoherent
   * — a move *is* an amendment, and there is no path that reinstates a referral
   * so moving a dead one only relocates a dead record.
   */
  function assertOpenToChange(referral: Referral): void {
    if (referral.status === 'cancelled') {
      throw new ConflictError('That referral has been cancelled');
    }
    if (referral.status === 'rejected') {
      throw new ConflictError('That referral was rejected');
    }
  }

  /** Applies an amendment. Admin only — there is no self-service path. */
  async function applyAmendment(
    referral: Referral,
    input: ReferralAmend,
    actor: { kind: 'user'; userId: string | null },
  ): Promise<Referral> {
    assertOpenToChange(referral);

    const patch: Patch<NewReferral> = { updatedAt: clock.nowIso() };
    const changed: string[] = [];

    for (const field of [
      'referrerName',
      'referrerPhone',
      'refereeFirstName',
      'refereeSurname',
      'refereeDateOfBirth',
      'refereeAddress',
      'refereePostcode',
      'refereePhone',
      'adults',
      'children',
    ] as const) {
      const value = input[field];
      if (value !== undefined) {
        Object.assign(patch, { [field]: value });
        changed.push(field);
      }
    }

    for (const field of ['isDelivery', 'needsFuelHelp'] as const) {
      const value = input[field];
      if (value !== undefined) {
        Object.assign(patch, { [field]: value ? 1 : 0 });
        changed.push(field);
      }
    }

    if (input.reasonId !== undefined) {
      const reason = await referrers.findActiveReasonById(input.reasonId);
      if (reason === undefined) {
        throw new UnprocessableError('That reason for referral is no longer offered');
      }
      patch.reasonId = input.reasonId;
      changed.push('reasonId');
    }

    if (input.answers !== undefined) {
      // Replaced wholesale, not merged: the client holds the form and sends
      // the complete set of answers, so a key it omits has been removed.
      patch.answersJson = JSON.stringify(input.answers);
      changed.push('answers');
    }

    const adults = input.adults ?? referral.adults;
    const children = input.children ?? referral.children;
    if (adults + children <= 0) {
      throw new BadRequestError('A household must contain at least one person');
    }

    const updated = await repository.update(referral.id, patch);
    if (updated === undefined) {
      throw new NotFoundError('Referral not found');
    }

    // Field NAMES only. Recording the values would make this table a second,
    // un-purgeable copy of every referral.
    await repository.recordAudit({
      id: crypto.randomUUID(),
      occurredAt: clock.nowIso(),
      actorKind: actor.kind,
      actorUserId: actor.userId,
      entityType: 'referral',
      entityId: referral.id,
      action: 'amended',
      detailJson: JSON.stringify({ changedFields: changed }),
    });

    logger.info('referral amended', { referralId: referral.id, count: changed.length });
    return updated;
  }

  /**
   * Cancels a referral. Idempotent, but not a way of relabelling a rejection.
   *
   * A rejected referral is refused rather than quietly becoming `cancelled`:
   * the two are different things that happened, and `reviewComment` is the only
   * record of *why* the charity turned the household away. Overwriting the
   * status would leave that comment attached to a referral whose status no
   * longer says a review ever took place.
   */
  async function cancel(
    referral: Referral,
    reason: string | null,
    actor: { kind: 'user'; userId: string | null },
  ): Promise<Referral> {
    if (referral.status === 'cancelled') return referral; // Idempotent.
    if (referral.status === 'rejected') {
      throw new ConflictError('That referral was rejected');
    }

    const now = clock.nowIso();
    const updated = await repository.update(referral.id, {
      status: 'cancelled',
      cancelledAt: now,
      cancelledReason: reason,
      updatedAt: now,
    });
    if (updated === undefined) {
      throw new NotFoundError('Referral not found');
    }

    await repository.recordAudit({
      id: crypto.randomUUID(),
      occurredAt: now,
      actorKind: actor.kind,
      actorUserId: actor.userId,
      entityType: 'referral',
      entityId: referral.id,
      action: 'cancelled',
      detailJson: null,
    });

    logger.info('referral cancelled', { referralId: referral.id });
    return updated;
  }

  /** Admin move between sessions. Over-capacity requires explicit acknowledgement. */
  async function move(
    referral: Referral,
    sessionId: string,
    acknowledgeOverCapacity: boolean,
    actor: Actor,
  ): Promise<Referral> {
    if (referral.sessionId === sessionId) return referral;
    assertOpenToChange(referral);

    await assertSessionAccepts(sessionId, acknowledgeOverCapacity);

    const now = clock.nowIso();
    const updated = await repository.update(referral.id, { sessionId, updatedAt: now });
    if (updated === undefined) {
      throw new NotFoundError('Referral not found');
    }

    await repository.recordAudit({
      id: crypto.randomUUID(),
      occurredAt: now,
      actorKind: 'user',
      actorUserId: actor.userId,
      entityType: 'referral',
      entityId: referral.id,
      action: 'moved',
      detailJson: JSON.stringify({ changedFields: ['sessionId'] }),
    });

    logger.info('referral moved', { referralId: referral.id, sessionId, userId: actor.userId });
    return updated;
  }

  return {
    submit,
    getReferral,
    viewReferral,
    listReferrals,
    review,
    applyAmendment,
    cancel,
    move,
  };
}

export type ReferralsService = ReturnType<typeof createReferralsService>;
