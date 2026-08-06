import { describe, expect, it } from 'vitest';
import {
  horizonEnd,
  missingOccurrences,
  occurrenceKey,
  planOccurrences,
  type RecurrenceTemplate,
} from '../src/modules/sessions/materialisation.ts';

/** A Tuesday 10:00 session, open-ended. */
const tuesday: RecurrenceTemplate = {
  id: 'tpl-tue',
  weekday: 2,
  startTime: '10:00',
  durationMinutes: 120,
  location: 'Church Hall',
  capacity: 25,
  deliveryTime: null,
  deliveriesAllowed: true,
  activeFrom: '2026-01-01',
  activeUntil: null,
};

describe('occurrence planning', () => {
  it('plans six weeks of a weekly template', () => {
    const planned = planOccurrences([tuesday], { from: '2026-07-27', horizonWeeks: 6 });

    expect(planned.map((o) => o.sessionDate)).toEqual([
      '2026-07-28',
      '2026-08-04',
      '2026-08-11',
      '2026-08-18',
      '2026-08-25',
      '2026-09-01',
    ]);
    // Six weeks is a horizon, not a count: 27 July + 42 days is 7 September,
    // which contains six Tuesdays.
    expect(horizonEnd({ from: '2026-07-27', horizonWeeks: 6 })).toBe('2026-09-07');
  });

  it('keeps a session at 10:00 local across the BST boundary', () => {
    // The horizon spans the end of BST on Sunday 25 October 2026.
    const planned = planOccurrences([tuesday], { from: '2026-10-13', horizonWeeks: 4 });

    const byDate = new Map(planned.map((o) => [o.sessionDate, o]));

    // Still BST: 10:00 local is 09:00Z.
    expect(byDate.get('2026-10-20')?.startsAtUtc).toBe('2026-10-20T09:00:00.000Z');
    // Back to GMT: 10:00 local is 10:00Z. The wall clock did not move.
    expect(byDate.get('2026-10-27')?.startsAtUtc).toBe('2026-10-27T10:00:00.000Z');

    expect(planned.every((o) => o.startTime === '10:00')).toBe(true);
  });

  it('does the same across the spring transition', () => {
    const planned = planOccurrences([tuesday], { from: '2026-03-17', horizonWeeks: 3 });
    const byDate = new Map(planned.map((o) => [o.sessionDate, o]));

    expect(byDate.get('2026-03-24')?.startsAtUtc).toBe('2026-03-24T10:00:00.000Z'); // GMT
    expect(byDate.get('2026-03-31')?.startsAtUtc).toBe('2026-03-31T09:00:00.000Z'); // BST
  });

  it('respects a template that has not started yet', () => {
    const future = { ...tuesday, id: 'tpl-future', activeFrom: '2026-08-15' };

    const planned = planOccurrences([future], { from: '2026-07-27', horizonWeeks: 6 });

    expect(planned.map((o) => o.sessionDate)).toEqual(['2026-08-18', '2026-08-25', '2026-09-01']);
  });

  it('stops at a retired template’s end date', () => {
    const retiring = { ...tuesday, id: 'tpl-retiring', activeUntil: '2026-08-12' };

    const planned = planOccurrences([retiring], { from: '2026-07-27', horizonWeeks: 6 });

    expect(planned.map((o) => o.sessionDate)).toEqual(['2026-07-28', '2026-08-04', '2026-08-11']);
  });

  it('ignores a template whose window has already closed', () => {
    const expired = { ...tuesday, id: 'tpl-old', activeUntil: '2026-01-31' };

    expect(planOccurrences([expired], { from: '2026-07-27', horizonWeeks: 6 })).toEqual([]);
  });

  it('copies the delivery fields from the template onto every occurrence', () => {
    const withDelivery: RecurrenceTemplate = {
      ...tuesday,
      id: 'tpl-delivery',
      deliveryTime: '09:00',
      deliveriesAllowed: false,
    };

    const planned = planOccurrences([withDelivery], { from: '2026-07-27', horizonWeeks: 1 });

    expect(planned).toHaveLength(1);
    expect(planned[0]?.deliveryTime).toBe('09:00');
    expect(planned[0]?.deliveriesAllowed).toBe(false);
  });

  it('interleaves several templates in chronological order', () => {
    const thursday: RecurrenceTemplate = {
      ...tuesday,
      id: 'tpl-thu',
      weekday: 4,
      startTime: '14:00',
    };

    const planned = planOccurrences([tuesday, thursday], { from: '2026-07-27', horizonWeeks: 1 });

    expect(planned.map((o) => `${o.sessionDate} ${o.startTime}`)).toEqual([
      '2026-07-28 10:00',
      '2026-07-30 14:00',
    ]);
  });

  it('reports only the occurrences that do not exist yet', () => {
    const planned = planOccurrences([tuesday], { from: '2026-07-27', horizonWeeks: 2 });
    const existing = new Set([occurrenceKey('tpl-tue', '2026-07-28')]);

    const missing = missingOccurrences(planned, existing);

    expect(missing.map((o) => o.occurrenceDate)).toEqual(['2026-08-04']);
  });

  it('reports nothing missing when everything already exists', () => {
    const planned = planOccurrences([tuesday], { from: '2026-07-27', horizonWeeks: 2 });
    const existing = new Set(
      planned.map((o) => occurrenceKey(o.recurringSessionId, o.occurrenceDate)),
    );

    expect(missingOccurrences(planned, existing)).toEqual([]);
  });
});
