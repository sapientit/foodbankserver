import type { Clock } from '../../core/clock.ts';
import type { Patch } from '../../core/types.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import { londonWallClockToInstant } from '../../core/time/london.ts';
import type { RecurringSession, Session } from '../../db/schema/sessions.ts';
import type { SessionListFilter, SessionsRepository } from './sessions.repository.ts';
import type { AdHocSessionInput, RecurringSessionInput, SessionPatch } from './sessions.schema.ts';

export interface SessionsServiceDeps {
  readonly repository: SessionsRepository;
  readonly clock: Clock;
}

export function createSessionsService({ repository, clock }: SessionsServiceDeps) {
  async function getSession(id: string): Promise<Session> {
    const session = await repository.findById(id);
    if (session === undefined) {
      throw new NotFoundError('Session not found');
    }
    return session;
  }

  async function createRecurring(input: RecurringSessionInput): Promise<RecurringSession> {
    const now = clock.nowIso();
    return repository.insertRecurring({
      ...input,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
  }

  async function updateRecurring(
    id: string,
    patch: Patch<RecurringSessionInput>,
  ): Promise<RecurringSession> {
    const updated = await repository.updateRecurring(id, { ...patch, updatedAt: clock.nowIso() });
    if (updated === undefined) {
      throw new NotFoundError('Recurring session not found');
    }
    return updated;
  }

  /** An ad hoc session belongs to no template, so the cron never touches it. */
  async function createAdHoc(input: AdHocSessionInput): Promise<Session> {
    const now = clock.nowIso();
    return repository.insertSession({
      id: crypto.randomUUID(),
      recurringSessionId: null,
      occurrenceDate: null,
      sessionDate: input.sessionDate,
      startTime: input.startTime,
      startsAtUtc: londonWallClockToInstant(input.sessionDate, input.startTime),
      durationMinutes: input.durationMinutes,
      location: input.location,
      capacity: input.capacity,
      status: 'planned',
      cancelledReason: null,
      isCustomised: 1,
      generatedAt: null,
      confirmedAt: null,
      confirmedByUserId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Re-times, re-locates or re-capacities one occurrence.
   *
   * `occurrenceDate` is deliberately left alone — it is the template slot this
   * row fills and the cron's idempotency key. Moving `sessionDate` to
   * Wednesday must not make the cron believe Tuesday is missing.
   */
  async function updateSession(id: string, patch: SessionPatch): Promise<Session> {
    const existing = await getSession(id);
    if (existing.status === 'confirmed') {
      throw new ConflictError('This session has been confirmed and can no longer be changed');
    }

    const sessionDate = patch.sessionDate ?? existing.sessionDate;
    const startTime = patch.startTime ?? existing.startTime;

    const updated = await repository.updateSession(id, {
      ...patch,
      sessionDate,
      startTime,
      // Always re-derive: changing either half changes the instant.
      startsAtUtc: londonWallClockToInstant(sessionDate, startTime),
      isCustomised: 1,
      updatedAt: clock.nowIso(),
    });
    if (updated === undefined) {
      throw new NotFoundError('Session not found');
    }
    return updated;
  }

  async function cancelSession(id: string, reason: string | null): Promise<Session> {
    const existing = await getSession(id);
    if (existing.status === 'cancelled') {
      return existing; // Idempotent: cancelling twice is not an error.
    }
    if (existing.status === 'confirmed') {
      throw new ConflictError('This session has been confirmed and can no longer be cancelled');
    }

    const updated = await repository.updateSession(id, {
      status: 'cancelled',
      cancelledReason: reason,
      isCustomised: 1,
      updatedAt: clock.nowIso(),
    });
    if (updated === undefined) {
      throw new NotFoundError('Session not found');
    }
    return updated;
  }

  return {
    getSession,
    listSessions: (filter: SessionListFilter) => repository.list(filter),
    listRecurring: () => repository.listRecurring(),
    createRecurring,
    updateRecurring,
    createAdHoc,
    updateSession,
    cancelSession,
  };
}

export type SessionsService = ReturnType<typeof createSessionsService>;
