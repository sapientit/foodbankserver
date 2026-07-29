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

    const pickList = await repository.findById(parcel.pickListId);
    if (pickList === undefined) {
      throw new NotFoundError('Pick list not found');
    }

    const now = clock.nowIso();
    const movement = movementFor(parcel.attendance, attendance);

    if (movement === undefined) {
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
        repository.buildParcelStockMovement({
          parcelId,
          sessionId: pickList.sessionId,
          movementType: movement.type,
          sign: movement.sign,
          actorUserId: actor.userId,
          occurredAt: now,
          lines,
        }),
        repository.buildSetAttendance({ parcelId, attendance, actorUserId: actor.userId, at: now }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error, ...PARCEL_GUARD)) {
        // Either a retry of a movement already applied, or a third attendance
        // change that would reuse a movement slot. Distinguish the two by what
        // the parcel currently says.
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

  /**
   * The stock movement a transition needs, or undefined for none.
   *
   * `pending → no_show` moves nothing: the parcel was never issued.
   * `attended → no_show` returns it, because it was.
   */
  function movementFor(
    from: AttendanceStatus,
    to: 'attended' | 'no_show',
  ): { type: 'parcel_issued' | 'parcel_returned'; sign: -1 | 1 } | undefined {
    if (to === 'attended') return { type: 'parcel_issued', sign: -1 };
    return from === 'attended' ? { type: 'parcel_returned', sign: 1 } : undefined;
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
   * A movement slot was already used for this parcel.
   *
   * If the parcel already reads as the requested outcome, this was a retry and
   * the earlier attempt succeeded — report success. Otherwise the team lead is
   * flipping attendance a third time, which would need a movement slot that is
   * spent. Refuse and point at the audited adjustment path rather than
   * inventing a compensating entry that cannot be told apart from a real one.
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

    // The stock movement was applied but the attendance update was rolled back
    // with it, so record the outcome and leave the ledger alone.
    if (current.attendance === 'pending') {
      return {
        parcel: await applyWithoutStock(parcelId, attendance, actor, at),
        stockMoved: false,
        alreadyRecorded: true,
      };
    }

    throw new ConflictError(
      'This parcel has already been issued and returned once. Ask an admin to correct the stock directly.',
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
