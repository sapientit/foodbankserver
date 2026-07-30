import { REFERRAL_EDIT_KEY_TTL_SECONDS } from '../../config/constants.ts';
import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { mintSecret, sha256Hex } from '../../core/crypto/tokens.ts';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
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
import type { ReferralSelfAmend, ReferralSubmission } from './referrals.schema.ts';

export interface SubmittedReferral {
  readonly referral: Referral;
  /** Plaintext, returned exactly once. Only its hash is stored. */
  readonly editKey: string;
  readonly editKeyExpiresAt: number;
}

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

    const booked = await repository.countActiveForSession(sessionId);
    if (booked >= session.capacity) {
      throw new ConflictError('That session is full', {
        details: { capacity: session.capacity, booked },
      });
    }
  }

  /**
   * Submits a referral. Unauthenticated.
   *
   * Three gates, in the order that fails cheapest first: the referrer must be
   * authorised, the session must be open and not full, and the reason must
   * still be offered.
   *
   * The dynamic answers are **not** a fourth gate. The referral form is client
   * configuration, so the server holds no definition to check them against and
   * stores what it is given.
   */
  async function submit(input: ReferralSubmission): Promise<SubmittedReferral> {
    const authorisation = await referrersService.checkAuthorisation(input.referrerEmail);
    if (!authorisation.authorised) {
      // Deliberately not "your address is not on the list" — that would confirm
      // which organisations are authorised to anyone who asks.
      logger.info('rejected referral from an unauthorised referrer');
      throw new ForbiddenError('That email address is not authorised to make referrals');
    }

    await assertSessionAccepts(input.sessionId, false);

    const reason = await referrers.findActiveReasonById(input.reasonId);
    if (reason === undefined) {
      throw new UnprocessableError('That reason for referral is no longer offered');
    }

    const now = clock.nowIso();
    const issuedAt = clock.nowEpochSeconds();
    const expiresAt = issuedAt + REFERRAL_EDIT_KEY_TTL_SECONDS;
    const referralId = crypto.randomUUID();
    const editKey = mintSecret();

    const referral: NewReferral = {
      id: referralId,
      sessionId: input.sessionId,
      status: 'active',
      referredAt: now,
      cancelledAt: null,
      cancelledReason: null,
      referrerOrganisation: authorisation.organisationName ?? 'Unknown',
      authorisedReferrerId: authorisation.matchedId,
      adults: input.adults,
      children: input.children,
      isDelivery: input.isDelivery ? 1 : 0,
      reasonId: input.reasonId,
      referrerEmail: input.referrerEmail.trim().toLowerCase(),
      referrerPhone: input.referrerPhone ?? null,
      refereeName: input.refereeName,
      refereeAddress: input.refereeAddress,
      refereePostcode: input.refereePostcode,
      refereePhone: input.refereePhone ?? null,
      answersJson: JSON.stringify(input.answers),
      piiPurgedAt: null,
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
    };

    // Referral, edit key and audit entry in one batch — there is no
    // transaction, and a referral without its key would strand the referrer.
    await db.batch([
      repository.buildInsertReferral(referral),
      repository.buildInsertEditKey({
        id: crypto.randomUUID(),
        referralId,
        keyHash: await sha256Hex(editKey),
        issuedAt,
        expiresAt,
        consumedAt: null,
        useCount: 0,
      }),
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

    const created = await getReferral(referralId);
    return { referral: created, editKey, editKeyExpiresAt: expiresAt };
  }

  /**
   * Resolves an edit key to the referral it authorises.
   *
   * A key that belongs to a *different* referral is a 403, not a 404: the
   * caller demonstrably holds a valid key, so telling them the referral exists
   * reveals nothing they could not already infer, and 404 would send them
   * chasing a phantom. Expiry is checked against server time only.
   */
  async function authoriseByEditKey(referralId: string, presentedKey: string): Promise<Referral> {
    const key = await repository.findEditKeyByHash(await sha256Hex(presentedKey));
    if (key === undefined) {
      throw new ForbiddenError('That edit key is not valid');
    }
    if (key.referralId !== referralId) {
      logger.warn('edit key presented against a different referral', { referralId });
      throw new ForbiddenError('That edit key is not valid for this referral');
    }
    if (key.consumedAt !== null) {
      throw new ForbiddenError('That edit key has already been used to delete this referral');
    }
    if (key.expiresAt <= clock.nowEpochSeconds()) {
      throw new ConflictError(
        'The 15-minute window for changing this referral has closed. Please phone the food bank.',
      );
    }

    await repository.recordEditKeyUse(key.id, key.useCount + 1);
    return getReferral(referralId);
  }

  /** Applies an amendment. Shared by the self-service and admin paths. */
  async function applyAmendment(
    referral: Referral,
    input: ReferralSelfAmend,
    actor: { kind: 'user' | 'referral_key'; userId: string | null },
  ): Promise<Referral> {
    if (referral.status === 'cancelled') {
      throw new ConflictError('That referral has been cancelled');
    }

    const patch: Patch<NewReferral> = { updatedAt: clock.nowIso() };
    const changed: string[] = [];

    for (const field of [
      'refereeName',
      'refereeAddress',
      'refereePostcode',
      'refereePhone',
      'referrerPhone',
      'adults',
      'children',
    ] as const) {
      const value = input[field];
      if (value !== undefined) {
        Object.assign(patch, { [field]: value });
        changed.push(field);
      }
    }

    if (input.isDelivery !== undefined) {
      patch.isDelivery = input.isDelivery ? 1 : 0;
      changed.push('isDelivery');
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

  async function cancel(
    referral: Referral,
    reason: string | null,
    actor: { kind: 'user' | 'referral_key'; userId: string | null },
  ): Promise<Referral> {
    if (referral.status === 'cancelled') return referral; // Idempotent.

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

  /** Self-service delete consumes the key, so it cannot be replayed. */
  async function withdraw(referral: Referral, keyHash: string): Promise<void> {
    await cancel(referral, 'Withdrawn by the referrer', { kind: 'referral_key', userId: null });

    const key = await repository.findEditKeyByHash(keyHash);
    if (key !== undefined) {
      await repository.consumeEditKey(key.id, clock.nowEpochSeconds());
    }
  }

  /** Admin move between sessions. Over-capacity requires explicit acknowledgement. */
  async function move(
    referral: Referral,
    sessionId: string,
    acknowledgeOverCapacity: boolean,
    actor: Actor,
  ): Promise<Referral> {
    if (referral.sessionId === sessionId) return referral;

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
    listReferrals: (filter: ReferralListFilter) => repository.list(filter),
    authoriseByEditKey,
    applyAmendment,
    cancel,
    withdraw,
    move,
  };
}

export type ReferralsService = ReturnType<typeof createReferralsService>;
