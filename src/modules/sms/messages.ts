/**
 * Composes the reminder text. Pure, no I/O.
 *
 * The reminder now greets the recipient by **first name only** — see
 * `INITIAL_SPEC1.txt`, "SMS reminders and replies". Never a surname, never an
 * address: a delivery reminder still never carries the household's address,
 * which stays the one thing this message must not carry.
 *
 * Three wordings:
 *
 * - **Collection**, for a household collecting its own parcel: weekday,
 *   the session's hours, location — and no date, because a reminder goes
 *   out in the week of the session.  Signed "the Foodbank", not "Guildford
 *   Food Bank": that is the charity's chosen wording for this one.
 * - **Delivery**: date and the session's effective delivery window — no
 *   location at all, because a delivered household must not be told anything
 *   about where they live.
 * - **Referrer collection**, for a `referrer_collect` referral: the
 *   referrer's own wording, greeting the referrer (not the household) by
 *   their first name, naming the parcel as "your client's", with the same
 *   weekday and hours as the collection wording.
 */

import { addMinutesToPlainTime } from '../../core/time/london.ts';
import { parsePlainDate } from '../../core/time/plain-date.ts';
import type { Session } from '../../db/schema/sessions.ts';
import { effectiveDeliveryWindow } from '../sessions/delivery-window.ts';

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

/** Same calendar-date reasoning as `dateFormatter`. */
const weekdayFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' });

function utcMidnight(date: string): Date {
  const { year, month, day } = parsePlainDate(date);
  return new Date(Date.UTC(year, month - 1, day));
}

/** `2026-08-14` → `Fri 14 Aug`. */
function formatSessionDate(date: string): string {
  return dateFormatter.format(utcMidnight(date));
}

/**
 * `Thursday 10:30 - 11:30` — the weekday and the session's own hours, for the
 * two collection wordings. The end is `startTime` plus `durationMinutes`.
 */
function formatCollectionSlot(session: Session): string {
  const weekday = weekdayFormatter.format(utcMidnight(session.sessionDate));
  const end = addMinutesToPlainTime(session.startTime, session.durationMinutes);
  return `${weekday} ${session.startTime} - ${end}`;
}

/**
 * The greeting clause every reminder opens with — `Hi {firstName} this is
 * {sender}.` when a first name is available, or the plain `This is
 * {sender}.` when it is not.  The household collection wording signs itself
 * "the Foodbank"; the others say "Guildford Food Bank". `firstName` being `null` should not
 * happen in practice — both `refereeFirstName` and `referrerName` are
 * required at referral submission — but the column is nullable, so this must
 * not throw on it.
 */
function greeting(firstName: string | null, sender = 'Guildford Food Bank'): string {
  return firstName === null ? `This is ${sender}.` : `Hi ${firstName} this is ${sender}.`;
}

/**
 * The first word of a full name, for a greeting — everything before the
 * first run of whitespace, once trimmed. `referrals.referrerName` is a single
 * free-text field with no separate first-name column, so this is how
 * `composeReferrerReminder` derives one. `null` in, `null` out.
 */
function firstNameOf(fullName: string | null): string | null {
  if (fullName === null) return null;
  const trimmed = fullName.trim();
  const firstWord = trimmed.split(/\s+/)[0];
  return firstWord === undefined || firstWord === '' ? null : firstWord;
}

/**
 * Composes the reminder for one household on one session.
 *
 * - **Collection**: weekday, the session's hours, location.
 * - **Delivery**: date and the session's **effective** delivery window (the
 *   stored pair, falling back to the session's own hours when it has not set
 *   one — see `delivery-window.ts`) — no location at all.
 */
export function composeReminder(
  session: Session,
  isDelivery: boolean,
  firstName: string | null,
): string {
  if (isDelivery) {
    const date = formatSessionDate(session.sessionDate);
    const window = effectiveDeliveryWindow(session);
    return `${greeting(firstName)} Your parcel will be delivered on ${date}, between ${window.start} and ${window.end}. Someone must be home to receive it. Any problems let us know.`;
  }

  const greetingClause = greeting(firstName, 'the Foodbank');
  const slot = formatCollectionSlot(session);
  return fitToLimit(
    (location) =>
      `${greetingClause} Please collect your food parcel on ${slot} from ${location}. Any problems let us know.`,
    session.location,
  );
}

/**
 * Composes the reminder for a `referrer_collect` referral, sent to the
 * referrer rather than the household — `INITIAL_SPEC1.txt`, "SMS reminders
 * and replies". `referrerName` is the referral's full-text `referrerName`
 * column; the first name is derived here via `firstNameOf`.
 */
export function composeReferrerReminder(session: Session, referrerName: string | null): string {
  const greetingClause = greeting(firstNameOf(referrerName));
  const slot = formatCollectionSlot(session);

  return fitToLimit(
    (location) =>
      `${greetingClause} Please collect your client's parcel as arranged on ${slot} from ${location}. Any problems let us know.`,
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
