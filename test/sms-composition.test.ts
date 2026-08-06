import { describe, expect, it } from 'vitest';
import { composeReminder } from '../src/modules/sms/messages.ts';
import { normalisePhone, phonesMatch } from '../src/modules/sms/phone.ts';
import type { Session } from '../src/db/schema/sessions.ts';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    recurringSessionId: null,
    occurrenceDate: null,
    sessionDate: '2026-08-14', // a Friday
    startTime: '10:00',
    startsAtUtc: '2026-08-14T09:00:00.000Z',
    durationMinutes: 120,
    location: 'Church Hall',
    capacity: 25,
    deliveryTime: null,
    deliveriesAllowed: 1,
    status: 'planned',
    cancelledReason: null,
    isCustomised: 0,
    generatedAt: null,
    confirmedAt: null,
    confirmedByUserId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('normalisePhone', () => {
  it('normalises the four shapes a referrer or the provider might use', () => {
    expect(normalisePhone('07700 900123')).toBe('+447700900123');
    expect(normalisePhone('+447700900123')).toBe('+447700900123');
    expect(normalisePhone('447700900123')).toBe('+447700900123');
    expect(normalisePhone('07700900123')).toBe('+447700900123');
  });

  it('tolerates hyphens and parentheses', () => {
    expect(normalisePhone('(07700) 900-123')).toBe('+447700900123');
  });

  it('returns null for a number that is not a recognisable UK number', () => {
    expect(normalisePhone('not a number')).toBeNull();
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('+1 555 0100')).toBeNull(); // a different country code
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone('   ')).toBeNull();
  });
});

describe('phonesMatch', () => {
  it('matches two numbers written differently that are the same number', () => {
    expect(phonesMatch('07700 900123', '+447700900123')).toBe(true);
  });

  it('does not match two different numbers', () => {
    expect(phonesMatch('07700 900123', '07700 900124')).toBe(false);
  });

  it('does not match when either side cannot be normalised', () => {
    expect(phonesMatch('not a number', '+447700900123')).toBe(false);
  });
});

describe('composeReminder', () => {
  it('gives a collecting household the date, time and place, and no more', () => {
    const message = composeReminder(session(), false);

    expect(message).toBe(
      'Reminder: your food bank collection is Fri 14 Aug at 10:00, Church Hall. Reply to this message if anything has changed.',
    );
  });

  it('gives a delivered household the date and delivery time and no place at all', () => {
    const message = composeReminder(session({ deliveryTime: '13:00' }), true);

    expect(message).toBe(
      'Reminder: your food bank delivery is Fri 14 Aug, around 13:00. Reply to this message if anything has changed.',
    );
    expect(message).not.toContain('Church Hall');
  });

  it('falls back to the start time when the session has no delivery time', () => {
    const message = composeReminder(session({ deliveryTime: null, startTime: '09:30' }), true);

    expect(message).toContain('around 09:30');
  });

  it('never carries an address on a delivery reminder', () => {
    // `composeReminder` takes a `Session` and a boolean — there is no
    // household parameter for a name or address to leak in from, and this
    // pins down the one field a delivery message must never carry.
    const delivery = composeReminder(session({ location: '221B Baker Street' }), true);

    expect(delivery).not.toContain('Baker Street');
  });

  it('stays within one SMS segment (160 GSM-7 characters)', () => {
    expect(composeReminder(session(), false).length).toBeLessThanOrEqual(160);
    expect(composeReminder(session({ deliveryTime: '13:00' }), true).length).toBeLessThanOrEqual(
      160,
    );
  });

  it('truncates a long location rather than exceeding one segment', () => {
    const longLocation = 'A'.repeat(200);
    const message = composeReminder(session({ location: longLocation }), false);

    expect(message.length).toBeLessThanOrEqual(160);
    expect(message).toContain('Reminder: your food bank collection is Fri 14 Aug at 10:00,');
  });

  it('reads the same weekday and day regardless of the BST changeover', () => {
    // 27 October 2026 is the last Sunday of the month — the moment the clocks
    // go back. The session date is a plain calendar date, not an instant, so
    // this must not shift.
    const message = composeReminder(
      session({ sessionDate: '2026-10-27', startTime: '10:00' }),
      false,
    );
    expect(message).toContain('Tue 27 Oct');
  });
});
