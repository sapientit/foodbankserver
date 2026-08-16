import type { RecurringSession, Session } from '../../db/schema/sessions.ts';
import { effectiveDeliveryWindow } from './delivery-window.ts';
import type { SessionWithBooked } from './sessions.repository.ts';

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
  /**
   * Active referrals on this session — households, not people, so it is
   * directly comparable with `capacity`. Derived, never stored.
   */
  readonly booked: number;
  readonly status: string;
  readonly cancelledReason: string | null;
  readonly isCustomised: boolean;
  readonly recurringSessionId: string | null;
  readonly occurrenceDate: string | null;
  /**
   * `HH:MM` London wall clock, both or neither, exactly as stored — not the
   * effective window. An admin screen needs to know whether one is set at
   * all, to be able to clear it; that distinction is lost by resolving the
   * fallback here the way the public response does.
   */
  readonly deliveryWindowStart: string | null;
  readonly deliveryWindowEnd: string | null;
  readonly deliveriesAllowed: boolean;
}

/**
 * Takes the pair rather than a bare `Session` on purpose: `booked` has no
 * sensible default, and an optional parameter would let a call site quietly
 * omit it and report every session as empty.
 */
export function toSessionResponse({ session, booked }: SessionWithBooked): SessionResponse {
  return {
    id: session.id,
    sessionDate: session.sessionDate,
    startTime: session.startTime,
    startsAtUtc: session.startsAtUtc,
    durationMinutes: session.durationMinutes,
    location: session.location,
    capacity: session.capacity,
    booked,
    status: session.status,
    cancelledReason: session.cancelledReason,
    isCustomised: session.isCustomised === 1,
    recurringSessionId: session.recurringSessionId,
    occurrenceDate: session.occurrenceDate,
    deliveryWindowStart: session.deliveryWindowStart,
    deliveryWindowEnd: session.deliveryWindowEnd,
    deliveriesAllowed: session.deliveriesAllowed === 1,
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
  readonly deliveriesAllowed: boolean;
  /**
   * The **effective** window, never null — this deliberately widens the
   * narrowest response in the API, on purpose. The referral form now asks
   * the referrer to confirm the client will be at home for the delivery
   * window, and it cannot ask that without stating the window. A delivery
   * window is a fact about a session, not about any household — the same
   * thing a leaflet saying when the van comes would say. It names nobody.
   *
   * Resolved server-side rather than shipping the raw, possibly-null pair:
   * the client would otherwise have to re-derive the "no window set" ->
   * "the session's own hours" rule itself.
   */
  readonly deliveryWindowStart: string;
  readonly deliveryWindowEnd: string;
}

export function toPublicSessionResponse(session: Session): PublicSessionResponse {
  const window = effectiveDeliveryWindow(session);
  return {
    id: session.id,
    sessionDate: session.sessionDate,
    startTime: session.startTime,
    startsAtUtc: session.startsAtUtc,
    durationMinutes: session.durationMinutes,
    location: session.location,
    deliveriesAllowed: session.deliveriesAllowed === 1,
    deliveryWindowStart: window.start,
    deliveryWindowEnd: window.end,
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
  /** `HH:MM` London wall clock, both or neither, exactly as stored. */
  readonly deliveryWindowStart: string | null;
  readonly deliveryWindowEnd: string | null;
  readonly deliveriesAllowed: boolean;
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
    deliveryWindowStart: row.deliveryWindowStart,
    deliveryWindowEnd: row.deliveryWindowEnd,
    deliveriesAllowed: row.deliveriesAllowed === 1,
  };
}
