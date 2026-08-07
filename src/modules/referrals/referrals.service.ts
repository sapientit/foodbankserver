import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError, UnprocessableError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Patch } from '../../core/types.ts';
import type { Database } from '../../db/client.ts';
import {
  REFERRAL_STATUSES_HOLDING_A_PLACE,
  type NewReferral,
  type Referral,
} from '../../db/schema/referrals.ts';
import type { ReferrersRepository } from '../referrers/referrers.repository.ts';
import type { ReferrersService } from '../referrers/referrers.service.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import type { ReferralListFilter, ReferralsRepository } from './referrals.repository.ts';
import { toListenerSheetHousehold, type ListenerSheetHousehold } from './referrals.mapper.ts';
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
   * The listener sheet for a session: **one sheet, every household on it.**
   *
   * Not one per household — a listener is handed a single sheet and scans it
   * for whoever is in front of them, so it is ordered by surname rather than by
   * when the referral arrived.
   *
   * **Two queries whatever the session holds**: the referrals, and the reason
   * list once. A reason lookup per household would be 25+ on a plan that allows
   * 50, on a page opened at the start of every session.
   *
   * Retired reasons are included in that lookup. A referral cites the reason it
   * was made under, and the charity deactivating that reason afterwards must
   * not blank it out on the sheet.
   *
   * Who appears is `REFERRAL_STATUSES_HOLDING_A_PLACE` — awaiting review,
   * accepted and read alike, because whether an administrator has got round to
   * reading a referral says nothing about whether the household is coming. A
   * cancelled or rejected household is not coming, and handing a
   * volunteer the name and crisis of somebody the food bank turned away is the
   * harm this endpoint exists to avoid. **That choice is an assumption**, not a
   * stated requirement: see Q26.
   */
  async function listenerSheet(sessionId: string): Promise<ListenerSheetHousehold[]> {
    const session = await sessions.findById(sessionId);
    if (session === undefined) {
      throw new NotFoundError('Session not found');
    }

    const [households, reasons] = await Promise.all([
      repository.list({ sessionId }),
      referrers.listReasons(false),
    ]);

    const labelById = new Map(reasons.map((reason) => [reason.id, reason.label]));

    return households
      .filter((referral) =>
        REFERRAL_STATUSES_HOLDING_A_PLACE.some((status) => status === referral.status),
      )
      .sort(bySurnameThenFirstName)
      .map((referral) => toListenerSheetHousehold(referral, labelById.get(referral.reasonId)));
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
   * Only from `pending_review`: deciding an active referral again would be a
   * way of quietly reinstating a cancelled one, and rejecting a rejected one
   * twice says nothing new. The comment is overwritten rather than appended —
   * the charity asked for one line per decision, not a history.
   *
   * The "still pending" check is **in the statement, not here**. Checking it in
   * TypeScript first would be a read-then-write on a database with no
   * interactive transactions, so two administrators working the same queue
   * could both pass it and the second would silently overwrite the first — an
   * accept undoing a reject with nobody told.
   *
   * **Accepting lands on `active`, not `reviewed`.** Deciding a referral the
   * address held up and reading a referral through are two different passes;
   * the charity asked for every referral to be read, including the ones nothing
   * held up.
   *
   * `authoriseReferrer` is the second accept button: accept this one *and* put
   * the referrer on the authorised list so the next one is not held up. It adds
   * the referrer's own address and never the domain — see `authoriseReferrer`.
   */
  async function review(
    referralId: string,
    outcome: 'active' | 'rejected',
    comment: string | null,
    actor: Actor,
    authorise?: { organisationName: string },
  ): Promise<Referral> {
    // Before the accept, not after: the accept is guarded by its own WHERE and
    // may find nothing, and there is no transaction to undo a list entry with.
    // Authorising first means the failure an administrator can see (the address
    // is already on the list) happens while nothing has changed yet.
    if (authorise !== undefined) {
      await authoriseReferrer(referralId, authorise.organisationName, actor);
    }

    const now = clock.nowIso();
    const updated = await repository.updateIfStatus(referralId, 'pending_review', {
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

    logger.info('referral decided', { referralId, userId: actor.userId });
    return updated;
  }

  /**
   * Adds this referral's referrer to the authorised list, by address.
   *
   * **The address only, never the domain.** One person the charity has decided
   * to trust is not everybody who works where they work, and a domain rule
   * taken from a single referral would quietly authorise a whole council.
   *
   * The organisation name is the administrator's, typed on the screen — not
   * `referrerOrganisation`, which is free text the referrer chose and is how
   * the list ends up holding three spellings of one council. The referral's own
   * `referrerOrganisation` is left exactly as it was submitted; it is a record
   * of what the referrer said, not a field to tidy.
   *
   * `authorisedReferrerId` on the referral is left null too. It records the
   * match the server made **when the referral arrived**, and no rule matched
   * then. Backfilling it would make a referral that was held for review read
   * afterwards as one that never was.
   */
  async function authoriseReferrer(
    referralId: string,
    organisationName: string,
    actor: Actor,
  ): Promise<void> {
    const referral = await getReferral(referralId);
    const email = referral.referrerEmail;
    if (email === null) {
      throw new UnprocessableError('That referral has no referrer address to authorise');
    }

    await referrersService.create({ matchType: 'email', matchValue: email, organisationName });

    await repository.recordAudit({
      id: crypto.randomUUID(),
      occurredAt: clock.nowIso(),
      actorKind: 'user',
      actorUserId: actor.userId,
      entityType: 'referral',
      entityId: referralId,
      action: 'referrer_authorised',
      detailJson: null,
    });

    logger.info('referrer authorised from referral', { referralId, userId: actor.userId });
  }

  /**
   * Marks a referral as read by an administrator.
   *
   * Only from `active`. A referral still waiting for review has not been
   * decided yet, and one already reviewed, rejected or cancelled has nothing to
   * add — so the guard rides in the `WHERE` for the same reason the accept
   * decision does.
   *
   * This changes nothing else about the referral: it holds its place, it is
   * picked, and it appears on the listener sheet exactly as before. The only
   * thing it says is that somebody has read it.
   */
  async function markReviewed(referralId: string, actor: Actor): Promise<Referral> {
    const now = clock.nowIso();
    const updated = await repository.updateIfStatus(referralId, 'active', {
      status: 'reviewed',
      reviewedByUserId: actor.userId,
      updatedAt: now,
    });

    if (updated === undefined) {
      await getReferral(referralId);
      throw new ConflictError('That referral is not waiting to be read');
    }

    await repository.recordAudit({
      id: crypto.randomUUID(),
      occurredAt: now,
      actorKind: 'user',
      actorUserId: actor.userId,
      entityType: 'referral',
      entityId: referralId,
      action: 'reviewed',
      detailJson: null,
    });

    logger.info('referral read', { referralId, userId: actor.userId });
    return updated;
  }

  /**
   * A referral that is finished with cannot be changed, and neither can one on
   * a session that has been confirmed.
   *
   * Shared by amending, moving and cancelling because `PATCH /referrals/{id}`
   * does the first two and refusing one while allowing the other on the same
   * object is incoherent — a move *is* an amendment, and there is no path that
   * reinstates a referral so moving a dead one only relocates a dead record.
   *
   * **The session check guards the session the referral is already on.**
   * `assertSessionAccepts` refuses a referral *arriving* at a confirmed
   * session; without this, one could still be amended off, cancelled off, or
   * moved off it afterwards. A move off a confirmed session is the worst of
   * the three: the household ends up recorded against two sessions, and a
   * session confirmed with one set of figures quietly acquires another.
   */
  async function assertOpenToChange(referral: Referral): Promise<void> {
    if (referral.status === 'cancelled') {
      throw new ConflictError('That referral has been cancelled');
    }
    if (referral.status === 'rejected') {
      throw new ConflictError('That referral was rejected');
    }

    const session = await sessions.findById(referral.sessionId);
    if (session?.status === 'confirmed') {
      throw new ConflictError('This session has been confirmed and can no longer be changed');
    }
  }

  /**
   * Applies an amendment. Admin only — there is no self-service path.
   *
   * **The household's own details and the answers can be corrected**; moving it
   * to another session is the other thing that can happen to it. A referrer who
   * mistyped an address, or a household that has moved between being referred
   * and being fed, has to be correctable: a delivery goes to the address on the
   * referral, so a wrong one there is a parcel on the wrong doorstep.
   *
   * **The referrer's own details are not amendable.** `referrerEmail` is what
   * the authorisation decision was made on, and the rest is the record of who
   * sent the referral rather than a field to tidy up.
   *
   * Only fields actually supplied are written, so a one-field correction stays
   * a one-field correction. `answers` is the exception and replaces the set
   * outright: the client holds the form, so a key it omits has been removed.
   * Which answer counts as "other information" belongs to the form and the form
   * is the client's, so nothing here polices which key moved. See
   * `INITIAL_SPEC1.txt`, "Referral maintenance".
   *
   * The audit records **field names only, never values** — see `recordAudit`
   * below. So this overwrites: what the referrer originally sent is not kept,
   * which is the charity's decision and not an oversight.
   */
  async function applyAmendment(
    referral: Referral,
    input: ReferralAmend,
    actor: { kind: 'user'; userId: string | null },
  ): Promise<Referral> {
    await assertOpenToChange(referral);

    // Same check the submission makes, and for the same reason: `reasonId` is a
    // foreign key, so an unknown one would surface as a raw database error —
    // whose message carries the bound row. It must be refused here instead.
    // Active only: an administrator correcting a reason picks from what the
    // charity currently offers, even though a referral already citing a retired
    // one keeps it.
    if (input.reasonId !== undefined) {
      const reason = await referrers.findActiveReasonById(input.reasonId);
      if (reason === undefined) {
        throw new UnprocessableError('That reason for referral is no longer offered');
      }
    }

    const patch: Patch<NewReferral> = { updatedAt: clock.nowIso() };
    const changed: string[] = [];

    // Written one at a time rather than by spreading `input`, so the patch can
    // never carry a key the schema gains later without somebody deciding it
    // should be amendable. The mapper is the output allowlist; this is the
    // input one.
    const assign = <K extends keyof NewReferral>(
      field: K,
      value: NewReferral[K] | undefined,
      name: string,
    ): void => {
      if (value === undefined) return;
      patch[field] = value;
      changed.push(name);
    };

    assign('refereeFirstName', input.refereeFirstName, 'refereeFirstName');
    assign('refereeSurname', input.refereeSurname, 'refereeSurname');
    assign('refereeDateOfBirth', input.refereeDateOfBirth, 'refereeDateOfBirth');
    assign('refereeAddress', input.refereeAddress, 'refereeAddress');
    assign('refereePostcode', input.refereePostcode, 'refereePostcode');
    assign('refereePhone', input.refereePhone, 'refereePhone');
    assign('adults', input.adults, 'adults');
    assign('children', input.children, 'children');
    assign('reasonId', input.reasonId, 'reasonId');

    // Booleans are integers in SQLite, so they cannot go through `assign`.
    if (input.isDelivery !== undefined) {
      patch.isDelivery = input.isDelivery ? 1 : 0;
      changed.push('isDelivery');
    }
    if (input.needsFuelHelp !== undefined) {
      patch.needsFuelHelp = input.needsFuelHelp ? 1 : 0;
      changed.push('needsFuelHelp');
    }

    if (input.answers !== undefined) {
      // Replaced wholesale, not merged: the client holds the form and sends
      // the complete set of answers, so a key it omits has been removed.
      patch.answersJson = JSON.stringify(input.answers);
      changed.push('answers');
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
    // Same guard as amending and moving: a rejection is not a cancellation,
    // and a confirmed session is closed to all three.
    await assertOpenToChange(referral);

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
    await assertOpenToChange(referral);

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
    listenerSheet,
    getReferral,
    viewReferral,
    listReferrals,
    review,
    markReviewed,
    applyAmendment,
    cancel,
    move,
  };
}

export type ReferralsService = ReturnType<typeof createReferralsService>;

/**
 * Surname first, then first name. A blank name sorts last: a purged referral
 * has nothing to look up and belongs at the bottom rather than the top.
 */
function bySurnameThenFirstName(left: Referral, right: Referral): number {
  const key = (referral: Referral): string =>
    `${referral.refereeSurname ?? '\uffff'} ${referral.refereeFirstName ?? ''}`.toLowerCase();
  return key(left).localeCompare(key(right));
}
