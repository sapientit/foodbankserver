/**
 * The window of sessions the unauthenticated list offers.
 *
 * Pure and I/O-free, because the rule is entirely about the clock and the
 * calendar and is the kind of thing that is easy to get wrong by an hour or a
 * day. The route does the query; this decides what to ask for.
 */

import {
  PUBLIC_SESSION_BOOKING_CUTOFF,
  PUBLIC_SESSION_WINDOW_DAYS,
} from '../../config/constants.ts';
import {
  instantToLondonWallClock,
  londonWallClockToInstant,
  parsePlainTime,
} from '../../core/time/london.ts';
import { addDays, type PlainDate } from '../../core/time/plain-date.ts';

function minutesIntoDay(time: string): number {
  const { hour, minute } = parsePlainTime(time);
  return hour * 60 + minute;
}

/**
 * The earliest session date the public list will still offer.
 *
 * Referrals close at 16:00 London the day before a session, so the soonest
 * session on offer is tomorrow's up to and including the 16:00 minute today,
 * and the day after's from 16:01. **The comparison is inclusive on purpose**:
 * four o'clock is the moment a referrer is asked to be in by, so somebody
 * submitting at 16:00 has made it. That is the charity's own worked example —
 * "at 16:01 you would stop offering the next day".
 *
 * Today's own sessions are never offered, whatever the time: their deadline
 * was yesterday afternoon.
 */
export function firstOfferableDate(nowIso: string): PlainDate {
  const { date, time } = instantToLondonWallClock(nowIso);
  const daysAhead = minutesIntoDay(time) <= minutesIntoDay(PUBLIC_SESSION_BOOKING_CUTOFF) ? 1 : 2;
  return addDays(date, daysAhead);
}

/**
 * The instant window the public list queries on, since that is what session
 * rows are indexed by: from the start of the first offerable day to the end of
 * the last day in the fourteen-day window.
 *
 * The far end is counted from today and does not move with the cutoff, so the
 * list shortens as the afternoon passes rather than sliding forward — "the
 * next two weeks" is two weeks from now, not two weeks from whenever the next
 * bookable day happens to be.
 */
export function publicSessionWindow(nowIso: string): { fromUtc: string; toUtc: string } {
  const today = instantToLondonWallClock(nowIso).date;

  return {
    fromUtc: londonWallClockToInstant(firstOfferableDate(nowIso), '00:00'),
    toUtc: londonWallClockToInstant(addDays(today, PUBLIC_SESSION_WINDOW_DAYS), '23:59'),
  };
}
