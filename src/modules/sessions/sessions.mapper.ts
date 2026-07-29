import type { RecurringSession, Session } from '../../db/schema/sessions.ts';

/**
 * Response mappers are the output allowlist.
 *
 * Hono has no response-schema mechanism, so this is what stops a newly added
 * column reaching a client that should not see it. Adding a field to a table
 * must never widen an API response by accident — it has to be added here on
 * purpose.
 */

export interface SessionResponse {
  readonly id: string;
  readonly sessionDate: string;
  readonly startTime: string;
  readonly startsAtUtc: string;
  readonly durationMinutes: number;
  readonly location: string;
  readonly capacity: number;
  readonly status: string;
  readonly cancelledReason: string | null;
  readonly isCustomised: boolean;
  readonly recurringSessionId: string | null;
  readonly occurrenceDate: string | null;
}

export function toSessionResponse(session: Session): SessionResponse {
  return {
    id: session.id,
    sessionDate: session.sessionDate,
    startTime: session.startTime,
    startsAtUtc: session.startsAtUtc,
    durationMinutes: session.durationMinutes,
    location: session.location,
    capacity: session.capacity,
    status: session.status,
    cancelledReason: session.cancelledReason,
    isCustomised: session.isCustomised === 1,
    recurringSessionId: session.recurringSessionId,
    occurrenceDate: session.occurrenceDate,
  };
}

/**
 * The unauthenticated view.
 *
 * Deliberately narrower: no capacity, no remaining places, no internal ids
 * beyond the one needed to make a referral. Publishing how full a session is
 * leaks operational detail and invites gaming.
 */
export interface PublicSessionResponse {
  readonly id: string;
  readonly sessionDate: string;
  readonly startTime: string;
  readonly startsAtUtc: string;
  readonly durationMinutes: number;
  readonly location: string;
}

export function toPublicSessionResponse(session: Session): PublicSessionResponse {
  return {
    id: session.id,
    sessionDate: session.sessionDate,
    startTime: session.startTime,
    startsAtUtc: session.startsAtUtc,
    durationMinutes: session.durationMinutes,
    location: session.location,
  };
}

export interface RecurringSessionResponse {
  readonly id: string;
  readonly name: string;
  readonly weekday: number;
  readonly startTime: string;
  readonly durationMinutes: number;
  readonly location: string;
  readonly capacity: number;
  readonly activeFrom: string;
  readonly activeUntil: string | null;
}

export function toRecurringSessionResponse(row: RecurringSession): RecurringSessionResponse {
  return {
    id: row.id,
    name: row.name,
    weekday: row.weekday,
    startTime: row.startTime,
    durationMinutes: row.durationMinutes,
    location: row.location,
    capacity: row.capacity,
    activeFrom: row.activeFrom,
    activeUntil: row.activeUntil,
  };
}
