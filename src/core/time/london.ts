/**
 * Europe/London wall clock ↔ UTC instant.
 *
 * The food bank thinks in wall clock: a session is "Tuesday at 10:00", and it
 * stays 10:00 on both sides of the BST changeover. But the public "next 14
 * days" filter has to compare instants. So a session row stores both: the
 * wall clock the charity typed, and the derived instant the query sorts on.
 *
 * Workers ships full ICU, so `Intl` does all of this and no timezone library
 * is needed. Getting the direction backwards silently moves every session by
 * an hour for half the year, which is why this module is small, pure, and
 * heavily tested.
 */

import { parsePlainDate, type PlainDate } from './plain-date.ts';

export const LONDON = 'Europe/London';

export type PlainTime = string;

const PLAIN_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function parsePlainTime(value: string): { hour: number; minute: number } {
  const match = PLAIN_TIME_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`Not a HH:MM time: ${value}`);
  }
  const [, hourText, minuteText] = match;
  if (hourText === undefined || minuteText === undefined) {
    throw new Error(`Not a HH:MM time: ${value}`);
  }
  return { hour: Number(hourText), minute: Number(minuteText) };
}

export function isPlainTime(value: string): boolean {
  return PLAIN_TIME_PATTERN.test(value);
}

/**
 * The wall-clock reading in London at a given instant, expressed as the epoch
 * milliseconds that reading *would* have if it were UTC. The difference
 * between that and the true instant is London's offset at that moment.
 */
function londonReadingAsUtcMs(instantMs: number): number {
  const parts = partsFormatter.formatToParts(new Date(instantMs));

  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of parts) {
    values[part.type] = part.value;
  }

  const { year, month, day, hour, minute, second } = values;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new Error('Intl did not return the expected date parts for Europe/London');
  }

  // Some ICU builds render midnight as hour 24 under hour12:false.
  const hourNumber = Number(hour) % 24;

  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    hourNumber,
    Number(minute),
    Number(second),
  );
}

function londonOffsetMsAt(instantMs: number): number {
  return londonReadingAsUtcMs(instantMs) - instantMs;
}

/**
 * Converts a London wall-clock date and time to a UTC instant.
 *
 * Two passes: guess the instant using the offset at the naive reading, then
 * re-derive the offset at that candidate. That second pass is what makes the
 * BST boundaries correct.
 *
 * Boundary behaviour, both deliberate:
 * - A time that does not exist (01:30 on the spring-forward Sunday) resolves
 *   forward into BST.
 * - A time that occurs twice (01:30 on the autumn Sunday) resolves to the
 *   first, BST, occurrence.
 *
 * Neither matters for a food bank session, but silent inconsistency would.
 */
export function londonWallClockToInstant(date: PlainDate, time: PlainTime): string {
  const { year, month, day } = parsePlainDate(date);
  const { hour, minute } = parsePlainTime(time);

  const naiveMs = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuessMs = naiveMs - londonOffsetMsAt(naiveMs);
  const instantMs = naiveMs - londonOffsetMsAt(firstGuessMs);

  return new Date(instantMs).toISOString();
}

/** The London wall-clock reading at a given instant. */
export function instantToLondonWallClock(instant: string): { date: PlainDate; time: PlainTime } {
  const instantMs = Date.parse(instant);
  if (Number.isNaN(instantMs)) {
    throw new Error(`Not a valid instant: ${instant}`);
  }

  const readingMs = londonReadingAsUtcMs(instantMs);
  const iso = new Date(readingMs).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** True when London is on British Summer Time at the given instant. */
export function isBritishSummerTime(instant: string): boolean {
  const instantMs = Date.parse(instant);
  if (Number.isNaN(instantMs)) {
    throw new Error(`Not a valid instant: ${instant}`);
  }
  return londonOffsetMsAt(instantMs) !== 0;
}
