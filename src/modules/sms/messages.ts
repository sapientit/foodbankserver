/**
 * Composes the reminder text. Pure, no I/O.
 *
 * **The message must never contain the household's name or address** — see
 * `INITIAL_SPEC1.txt`, "SMS reminders and replies", and
 * `docs/engineering/personal-data.md`. It only ever takes a `Session` and a
 * `Referral`'s `isDelivery` flag, never the referee's own columns, so there is
 * nothing here that could leak a name even by accident.
 *
 * Two wordings, because a collecting household needs to know where to go and
 * a delivered one must not be told anything about where they live — the
 * address is the one thing this message must not carry, and the household
 * already knows their own delivery time slot is approximate.
 */

import { parsePlainDate } from '../../core/time/plain-date.ts';
import type { Session } from '../../db/schema/sessions.ts';

/** One SMS segment in GSM-7. Staying under this keeps a reminder one text. */
const MAX_MESSAGE_LENGTH = 160;

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  // Session dates are already Europe/London calendar dates (see
  // `db/schema/sessions.ts`), not instants — formatting in UTC against
  // midnight of that calendar date reads the same weekday and day everywhere,
  // with no instant conversion needed or wanted.
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/** `2026-08-14` → `Fri 14 Aug`. */
function formatSessionDate(date: string): string {
  const { year, month, day } = parsePlainDate(date);
  return dateFormatter.format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * Composes the reminder for one household on one session.
 *
 * - **Collection**: date, start time, location.
 * - **Delivery**: date and `deliveryTime` (falling back to `startTime` when
 *   the session does not override it) — no location at all.
 */
export function composeReminder(session: Session, isDelivery: boolean): string {
  const date = formatSessionDate(session.sessionDate);

  if (isDelivery) {
    const time = session.deliveryTime ?? session.startTime;
    return `Reminder: your food bank delivery is ${date}, around ${time}. Reply to this message if anything has changed.`;
  }

  return fitToLimit(
    (location) =>
      `Reminder: your food bank collection is ${date} at ${session.startTime}, ${location}. Reply to this message if anything has changed.`,
    session.location,
  );
}

/**
 * Builds a message from a variable part, trimming that part if the result
 * would exceed one SMS segment.
 *
 * `location` is free text up to 200 characters (`sessions.schema.ts`), and the
 * fixed wording around it can already run to a third of a segment, so a long
 * location is the one part of the message that can overflow. Trimming it
 * quietly is better than refusing to send a reminder over a maintenance
 * screen's character limit.
 */
function fitToLimit(build: (value: string) => string, value: string): string {
  let candidate = build(value);
  let trimmed = value;
  while (candidate.length > MAX_MESSAGE_LENGTH && trimmed.length > 0) {
    trimmed = trimmed.slice(0, -1);
    candidate = build(trimmed);
  }
  return candidate;
}
