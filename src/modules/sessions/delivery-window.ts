/**
 * The delivery window a household is told to expect their delivery in.
 *
 * Pure and I/O-free — read by both the response mapper (the effective window
 * a client is shown) and the SMS composer (the effective window a reminder
 * states), so the fallback rule lives in exactly one place rather than being
 * re-derived by each caller.
 */

import { addMinutesToPlainTime, type PlainTime } from '../../core/time/london.ts';

export interface DeliveryWindow {
  readonly start: PlainTime;
  readonly end: PlainTime;
}

/** The four fields a session or template needs to resolve its window from. */
export interface DeliveryWindowSource {
  readonly startTime: PlainTime;
  readonly durationMinutes: number;
  readonly deliveryWindowStart: PlainTime | null;
  readonly deliveryWindowEnd: PlainTime | null;
}

/**
 * The window a household is actually told, resolving the fallback.
 *
 * When a session sets no window, it delivers across its own hours —
 * `startTime` to `startTime` plus `durationMinutes` — because that is the
 * spec's own rule for what "no window" means, not a convenience default
 * invented here. When both ends are set, they are used as stored: rule 1
 * (both or neither) and rule 2 (end strictly after start) are enforced at
 * the Zod boundary, not here, so a stored pair can always be trusted.
 */
export function effectiveDeliveryWindow(source: DeliveryWindowSource): DeliveryWindow {
  if (source.deliveryWindowStart !== null && source.deliveryWindowEnd !== null) {
    return { start: source.deliveryWindowStart, end: source.deliveryWindowEnd };
  }
  return {
    start: source.startTime,
    end: addMinutesToPlainTime(source.startTime, source.durationMinutes),
  };
}
