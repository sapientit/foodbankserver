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
   * - **No-show** writes **no ledger entry at all**. Nothing was ever given
   *   away, so there is nothing to return — the parcel is simply unpacked.
   * - **The outcome is final.** A collection or delivery that has been
   *   recorded cannot be undone, so the contradicting outcome is refused and
   *   the mistake is put right through the audited stock adjustment path.
   *   Reversing it here would append a compensating ledger entry nobody could
   *   tell apart from a real movement.
   *
   * ## Why this cannot double-count
   *
   * A team lead will double-tap, and a slow request will be retried. There is
   * no transaction to make "check then write" safe, so exactly-once is
   * enforced by the unique index on
   * `(parcel_id, stock_item_id, movement_type)`: the second attempt violates
   * it, the whole batch rolls back, and this catches that specific violation
   * and reports success. Idempotent by construction rather than by discipline.
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
    if (parcel.attendance !== 'pending') {
      throw finalOutcomeConflict(parcelId, parcel.attendance);
    }

    const pickList = await repository.findById(parcel.pickListId);
    if (pickList === undefined) {
      throw new NotFoundError('Pick list not found');
    }

    const now = clock.nowIso();

    // A no-show issued nothing, so there is nothing for the ledger to say.
    if (attendance === 'no_show') {
      return {
        parcel: await applyWithoutStock(parcelId, attendance, actor, now),
        stockMoved: false,
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
   * The parcel had already been issued when this request tried to issue it.
   *
   * If the parcel now reads as the requested outcome, this was a retry and the
   * earlier attempt succeeded — report success. If it still reads `pending`,
   * the ledger row landed without its attendance update, so record the outcome
   * and leave the append-only ledger alone. Anything else is a contradicting
   * outcome, which is final and refused.
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

    throw finalOutcomeConflict(parcelId, current.attendance, cause);
  }

  /**
   * A recorded outcome is final: once a collection or delivery is confirmed it
   * cannot be undone. Point the team lead at the audited adjustment path,
   * which leaves a correction on the record rather than a reversal that reads
   * exactly like a real movement.
   */
  function finalOutcomeConflict(
    parcelId: string,
    recorded: AttendanceStatus,
    cause?: unknown,
  ): ConflictError {
    return new ConflictError(
      'This parcel has already been recorded and cannot be changed. Correct the stock directly instead.',
      { cause, details: { parcelId, currentAttendance: recorded } },
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
