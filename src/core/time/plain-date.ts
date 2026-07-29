/**
 * Arithmetic on calendar dates with no timezone attached.
 *
 * A `PlainDate` is a `YYYY-MM-DD` string. Session recurrence is expressed in
 * calendar terms ("every Tuesday"), and doing that arithmetic on instants is
 * how you end up generating a session on the wrong day twice a year. Convert
 * to an instant only at the boundary — see `london.ts`.
 */

export type PlainDate = string;

const PLAIN_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export function parsePlainDate(value: string): DateParts {
  const match = PLAIN_DATE_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`Not a YYYY-MM-DD date: ${value}`);
  }

  const [, yearText, monthText, dayText] = match;
  if (yearText === undefined || monthText === undefined || dayText === undefined) {
    throw new Error(`Not a YYYY-MM-DD date: ${value}`);
  }

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  // Round-trip through UTC to reject 2026-02-30 and friends, which the regex
  // happily accepts.
  const utcMs = Date.UTC(year, month - 1, day);
  const roundTripped = new Date(utcMs);
  if (
    roundTripped.getUTCFullYear() !== year ||
    roundTripped.getUTCMonth() !== month - 1 ||
    roundTripped.getUTCDate() !== day
  ) {
    throw new Error(`Not a real calendar date: ${value}`);
  }

  return { year, month, day };
}

export function isPlainDate(value: string): boolean {
  try {
    parsePlainDate(value);
    return true;
  } catch {
    return false;
  }
}

function formatPlainDate(utcMs: number): PlainDate {
  return new Date(utcMs).toISOString().slice(0, 10);
}

export function addDays(date: PlainDate, days: number): PlainDate {
  const { year, month, day } = parsePlainDate(date);
  return formatPlainDate(Date.UTC(year, month - 1, day + days));
}

/** ISO-8601 weekday: 1 = Monday … 7 = Sunday. */
export function weekdayOf(date: PlainDate): number {
  const { year, month, day } = parsePlainDate(date);
  const sundayBased = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sundayBased === 0 ? 7 : sundayBased;
}

/**
 * The first date on or after `from` that falls on `weekday` (ISO, 1 = Monday).
 * This is the seed for generating a recurring session's occurrences.
 */
export function nextWeekdayOnOrAfter(from: PlainDate, weekday: number): PlainDate {
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    throw new Error(`Weekday must be 1-7 (ISO), got: ${String(weekday)}`);
  }
  const shift = (weekday - weekdayOf(from) + 7) % 7;
  return addDays(from, shift);
}

/** Negative if a < b, zero if equal, positive if a > b. Lexicographic works for YYYY-MM-DD. */
export function comparePlainDates(a: PlainDate, b: PlainDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every `weekday` occurrence in `[from, to]` inclusive. */
export function weeklyOccurrences(from: PlainDate, to: PlainDate, weekday: number): PlainDate[] {
  const occurrences: PlainDate[] = [];
  let current = nextWeekdayOnOrAfter(from, weekday);
  while (comparePlainDates(current, to) <= 0) {
    occurrences.push(current);
    current = addDays(current, 7);
  }
  return occurrences;
}
