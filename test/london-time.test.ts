import { describe, expect, it } from 'vitest';
import {
  instantToLondonWallClock,
  isBritishSummerTime,
  londonWallClockToInstant,
} from '../src/core/time/london.ts';
import { addDays, weeklyOccurrences, weekdayOf } from '../src/core/time/plain-date.ts';

describe('London wall clock', () => {
  it('keeps a session at 10:00 local across the BST boundary', () => {
    // 2026: BST begins Sunday 29 March, ends Sunday 25 October.
    const winter = londonWallClockToInstant('2026-01-13', '10:00');
    const summer = londonWallClockToInstant('2026-07-14', '10:00');

    expect(winter).toBe('2026-01-13T10:00:00.000Z'); // GMT: local == UTC
    expect(summer).toBe('2026-07-14T09:00:00.000Z'); // BST: local == UTC+1

    // The point of storing both representations: the wall clock is unchanged
    // even though the instant moved by an hour.
    expect(instantToLondonWallClock(winter).time).toBe('10:00');
    expect(instantToLondonWallClock(summer).time).toBe('10:00');
  });

  it('identifies British Summer Time', () => {
    expect(isBritishSummerTime('2026-01-13T10:00:00.000Z')).toBe(false);
    expect(isBritishSummerTime('2026-07-14T09:00:00.000Z')).toBe(true);
  });

  it('handles the day either side of the spring transition', () => {
    expect(londonWallClockToInstant('2026-03-28', '10:00')).toBe('2026-03-28T10:00:00.000Z');
    expect(londonWallClockToInstant('2026-03-30', '10:00')).toBe('2026-03-30T09:00:00.000Z');
  });

  it('handles the day either side of the autumn transition', () => {
    expect(londonWallClockToInstant('2026-10-24', '10:00')).toBe('2026-10-24T09:00:00.000Z');
    expect(londonWallClockToInstant('2026-10-26', '10:00')).toBe('2026-10-26T10:00:00.000Z');
  });

  it('round-trips every hour of a transition day', () => {
    for (let hour = 3; hour < 24; hour++) {
      const time = `${String(hour).padStart(2, '0')}:00`;
      const instant = londonWallClockToInstant('2026-03-29', time);

      expect(instantToLondonWallClock(instant)).toEqual({ date: '2026-03-29', time });
    }
  });

  it('rejects a malformed time rather than guessing', () => {
    expect(() => londonWallClockToInstant('2026-01-13', '25:00')).toThrow(/HH:MM/);
    expect(() => londonWallClockToInstant('2026-02-30', '10:00')).toThrow(/calendar date/);
  });
});

describe('plain date arithmetic', () => {
  it('uses ISO weekdays', () => {
    expect(weekdayOf('2026-07-27')).toBe(1); // Monday
    expect(weekdayOf('2026-08-02')).toBe(7); // Sunday
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });

  it('generates six weeks of Tuesdays without drifting across BST', () => {
    const occurrences = weeklyOccurrences('2026-03-16', '2026-04-26', 2);

    expect(occurrences).toEqual([
      '2026-03-17',
      '2026-03-24',
      '2026-03-31',
      '2026-04-07',
      '2026-04-14',
      '2026-04-21',
    ]);
    expect(occurrences.every((date) => weekdayOf(date) === 2)).toBe(true);
  });
});
