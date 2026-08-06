import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import type { AttendanceStatus, Parcel } from '../../db/schema/pick-lists.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import type { PickListsRepository } from './pick-lists.repository.ts';

export interface AttendanceDeps {
  readonly db: Database;
  readonly repository: PickListsRepository;
  readonly sessions: SessionsRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface AttendanceResult {
  readonly parcel: Parcel;
  readonly stockMoved: boolean;
  /** True when the same outcome had already been recorded. */
  readonly alreadyRecorded: boolean;
}

/** The unique index that makes issuing stock exactly-once. */
const PARCEL_GUARD = [
  'stock_ledger.parcel_id',
  'stock_ledger.stock_item_id',
  'stock_ledger.movement_type',
] as const;

export function createAttendanceService(deps: AttendanceDeps) {
  const { db, repository, sessions, clock, logger } = deps;

  /**
   * Records whether a household turned up, moving stock if they did.
   *
   * ## The rules
   *
   * - **Attended** issues the parcel: one `parcel_issued` ledger row per line,
   *   negative, in a single batch with the attendance update.
   * - **No-show** deletes that parcel's movements. Nothing left the building,
   *   so nothing should have come off the shelves, and the parcel is unpacked.
   * - **An outcome can be taken back** while the session is open. This is the
   *   only way to fix a mis-tap: the hand correction that used to do it went
   *   with the stock simplification, and a team lead must not be left waiting
   *   for the next count to get a wrong figure put right.
   * - **Confirming the session ends it.** After that the outcome is fixed,
   *   because a session that has been signed off must not have its figures
   *   move underneath it.
   *
   * ## Why this cannot double-count, and why taking back needs no guard
   *
   * A team lead will double-tap, and a slow request will be retried. There is
   * no transaction to make "check then write" safe, so issuing exactly once is
   * enforced by the unique index on
   * `(parcel_id, stock_item_id, movement_type)`: the second attempt violates
   * it, the whole batch rolls back, and this catches that specific violation
   * and reports success.
   *
   * Taking back needs no such guard, because deleting rows that are already
   * gone is a no-op. The asymmetry is the point — issuing twice doubles a
   * movement, un-issuing twice does nothing the first did not already do.
   */
  async function record(
    parcelId: string,
    attendance: AttendanceStatus & ('attended' | 'no_show'),
    actor: Actor,
  ): Promise<AttendanceResult> {
    const parcel = await repository.findParcelById(parcelId);
    if (parcel === undefined) {
      throw new NotFoundError('Parcel not found');
    }
    if (parcel.attendance === attendance) {
      // Already in this state: nothing to do, and saying so is kinder than
      // a conflict when someone taps twice.
      return { parcel, stockMoved: false, alreadyRecorded: true };
    }
    if (parcel.reviewedAt === null) {
      throw new ConflictError('Review this pick list before recording attendance');
    }

    const pickList = await repository.findById(parcel.pickListId);
    if (pickList === undefined) {
      throw new NotFoundError('Pick list not found');
    }

    // Confirming the session is the end of it. Everything above this line can
    // be changed and nothing below it can.
    const session = await sessions.findById(pickList.sessionId);
    if (session?.status === 'confirmed') {
      throw new ConflictError(
        'This session has been confirmed, so its outcomes can no longer be changed',
        { details: { parcelId, currentAttendance: parcel.attendance } },
      );
    }

    const now = clock.nowIso();

    // A no-show gives back whatever the parcel took. Deleting rows that are
    // not there is a no-op, so this is the same statement whether the outcome
    // is being recorded for the first time or taken back.
    if (attendance === 'no_show') {
      await db.$client.batch([
        repository.buildDeleteParcelIssue(parcelId),
        repository.buildSetAttendance({ parcelId, attendance, actorUserId: actor.userId, at: now }),
      ]);

      logger.info('recorded attendance', {
        parcelId,
        sessionId: pickList.sessionId,
        code: attendance,
        userId: actor.userId,
      });

      return {
        parcel: await requireParcel(parcelId),
        stockMoved: parcel.attendance === 'attended',
        alreadyRecorded: false,
      };
    }

    const lines = await repository.listLinesFor(parcelId);
    if (lines.length === 0) {
      // An empty parcel is odd but not an error; record the attendance.
      return {
        parcel: await applyWithoutStock(parcelId, attendance, actor, now),
        stockMoved: false,
        alreadyRecorded: false,
      };
    }

    try {
      await db.$client.batch([
        repository.buildParcelIssue({
          parcelId,
          sessionId: pickList.sessionId,
          actorUserId: actor.userId,
          occurredAt: now,
          lines,
        }),
        repository.buildSetAttendance({ parcelId, attendance, actorUserId: actor.userId, at: now }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error, ...PARCEL_GUARD)) {
        // This parcel has already been issued. Whether that was this request
        // arriving twice or a genuine conflict is decided by what the parcel
        // now says.
        return handleGuardViolation(parcelId, attendance, actor, now, error);
      }
      throw error;
    }

    logger.info('recorded attendance', {
      parcelId,
      sessionId: pickList.sessionId,
      code: attendance,
      count: lines.length,
      userId: actor.userId,
    });

    return { parcel: await requireParcel(parcelId), stockMoved: true, alreadyRecorded: false };
  }

  async function applyWithoutStock(
    parcelId: string,
    attendance: 'attended' | 'no_show',
    actor: Actor,
    at: string,
  ): Promise<Parcel> {
    await db.$client.batch([
      repository.buildSetAttendance({ parcelId, attendance, actorUserId: actor.userId, at }),
    ]);

    logger.info('recorded attendance without a stock movement', {
      parcelId,
      code: attendance,
      userId: actor.userId,
    });
    return requireParcel(parcelId);
  }

  /**
   * The parcel was already issued when this request tried to issue it.
   *
   * Two requests raced and both read `pending` before either wrote; the index
   * let one through. If the parcel now reads as the requested outcome the other
   * request did this one's job, so report success. If it still reads `pending`,
   * the ledger rows landed without their attendance update — impossible from an
   * atomic batch, but the guard is defensive and repairing it costs one write.
   *
   * Anything else means the parcel changed to the *other* outcome underneath
   * this request. That is a real concurrent conflict rather than a mis-tap to
   * absorb: two people are recording the same household differently at the same
   * moment, and the one who lost should be told.
   */
  async function handleGuardViolation(
    parcelId: string,
    attendance: 'attended' | 'no_show',
    actor: Actor,
    at: string,
    cause: unknown,
  ): Promise<AttendanceResult> {
    const current = await requireParcel(parcelId);

    if (current.attendance === attendance) {
      logger.info('attendance retry; stock had already moved', { parcelId, userId: actor.userId });
      return { parcel: current, stockMoved: false, alreadyRecorded: true };
    }

    if (current.attendance === 'pending') {
      return {
        parcel: await applyWithoutStock(parcelId, attendance, actor, at),
        stockMoved: false,
        alreadyRecorded: true,
      };
    }

    throw new ConflictError(
      'Somebody else recorded this household at the same moment. Check the outcome and try again.',
      { cause, details: { parcelId, currentAttendance: current.attendance } },
    );
  }

  async function requireParcel(parcelId: string): Promise<Parcel> {
    const parcel = await repository.findParcelById(parcelId);
    if (parcel === undefined) {
      throw new NotFoundError('Parcel not found');
    }
    return parcel;
  }

  /**
   * Confirms the session once everyone has been ticked off.
   *
   * Refuses while anyone is still pending, and says who — a session confirmed
   * with people unaccounted for is a session whose stock figures are wrong.
   */
  async function confirmSession(sessionId: string, actor: Actor) {
    const session = await sessions.findById(sessionId);
    if (session === undefined) {
      throw new NotFoundError('Session not found');
    }
    if (session.status === 'confirmed') {
      return session; // Idempotent.
    }

    const pickList = await repository.findBySession(sessionId);
    if (pickList !== undefined) {
      const parcels = await repository.listParcels(pickList.id);
      const pending = parcels.filter((parcel) => parcel.attendance === 'pending');

      if (pending.length > 0) {
        throw new ConflictError('Some households have not been marked as attended or not', {
          details: { pendingPickNumbers: pending.map((parcel) => parcel.pickNumber) },
        });
      }
    }

    const now = clock.nowIso();
    const updated = await sessions.updateSession(sessionId, {
      status: 'confirmed',
      confirmedAt: now,
      confirmedByUserId: actor.userId,
      updatedAt: now,
    });
    if (updated === undefined) {
      throw new NotFoundError('Session not found');
    }

    logger.info('confirmed session', { sessionId, userId: actor.userId });
    return updated;
  }

  return { record, confirmSession };
}

export type AttendanceService = ReturnType<typeof createAttendanceService>;
