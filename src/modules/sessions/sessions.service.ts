import { TEAM_LEAD_SESSION_HORIZON_DAYS } from '../../config/constants.ts';
import { isAdmin, type Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import type { Patch } from '../../core/types.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import { instantToLondonWallClock, londonWallClockToInstant } from '../../core/time/london.ts';
import { addDays, comparePlainDates, type PlainDate } from '../../core/time/plain-date.ts';
import type { RecurringSession, Session } from '../../db/schema/sessions.ts';
import type {
  SessionListFilter,
  SessionsRepository,
  SessionWithBooked,
} from './sessions.repository.ts';
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

  /**
   * The same session, with its booked count attached for a response.
   *
   * A second query rather than a join, because this is one row: the join shape
   * exists for the list, where query count would otherwise scale with results.
   */
  async function withBooked(session: Session): Promise<SessionWithBooked> {
    return { session, booked: await repository.bookedFor(session.id) };
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

  /**
   * The staff session list, narrowed to what the caller's role may see.
   *
   * An admin gets the whole materialised six weeks, because rearranging the
   * calendar that far ahead is their job. A team lead gets today through today
   * plus six days: they run the session in front of them.
   *
   * The cap comes from the clock and the `Actor`, never from the request — a
   * `to` beyond the horizon is clamped back to it rather than obeyed, so the
   * window cannot be widened with a query parameter. Only the far end is
   * capped: "six days in advance" is a limit on looking forward, and a team
   * lead still needs the session just gone.
   */
  async function listSessions(
    actor: Actor,
    filter: SessionListFilter,
  ): Promise<SessionWithBooked[]> {
    if (isAdmin(actor)) return repository.list(filter);

    // London's date, not UTC's: at 00:30 on a summer morning they differ, and
    // taking the wrong one moves the whole horizon by a day.
    const today = instantToLondonWallClock(clock.nowIso()).date;
    const horizonEnd = addDays(today, TEAM_LEAD_SESSION_HORIZON_DAYS);

    return repository.list({
      ...filter,
      to: filter.to === undefined ? horizonEnd : earlierOf(filter.to, horizonEnd),
    });
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
    /** The raw row, for callers that need the record rather than a response. */
    getSession,
    getSessionWithBooked: async (id: string) => withBooked(await getSession(id)),
    listSessions,
    listRecurring: () => repository.listRecurring(),
    createRecurring,
    updateRecurring,
    // A session that has just been created can have no referrals yet, so this
    // is the one path where the count is known without asking.
    createAdHoc: async (input: AdHocSessionInput): Promise<SessionWithBooked> => ({
      session: await createAdHoc(input),
      booked: 0,
    }),
    updateSession: async (id: string, patch: SessionPatch) =>
      withBooked(await updateSession(id, patch)),
    cancelSession: async (id: string, reason: string | null) =>
      withBooked(await cancelSession(id, reason)),
  };
}

function earlierOf(a: PlainDate, b: PlainDate): PlainDate {
  return comparePlainDates(a, b) <= 0 ? a : b;
}

export type SessionsService = ReturnType<typeof createSessionsService>;
