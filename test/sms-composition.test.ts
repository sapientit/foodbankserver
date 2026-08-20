import { describe, expect, it } from 'vitest';
import { composeReminder } from '../src/modules/sms/messages.ts';
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
    deliveryWindowStart: null,
    deliveryWindowEnd: null,
    deliveryCapacity: 25,
    status: 'planned',
    cancelledReason: null,
    isCustomised: 0,
    generatedAt: null,
    confirmedAt: null,
    confirmedByUserId: null,
    extractedAt: null,
    extractClaimId: null,
    extractClaimedByUserId: null,
    extractClaimExpiresAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('composeReminder', () => {
  it('gives a collecting household the date, time and place, and no more', () => {
    const message = composeReminder(session(), false);

    expect(message).toBe(
      'Reminder: your food bank collection is Fri 14 Aug at 10:00, Church Hall. Reply to this message if anything has changed.',
    );
  });

  it('gives a delivered household the date and the stored delivery window and no place at all', () => {
    const message = composeReminder(
      session({ deliveryWindowStart: '13:00', deliveryWindowEnd: '15:00' }),
      true,
    );

    expect(message).toBe(
      'Reminder: your food bank delivery is Fri 14 Aug, between 13:00 and 15:00. Reply to this message if anything has changed.',
    );
    expect(message).not.toContain('Church Hall');
  });

  it('falls back to the session’s own hours when it has no delivery window set', () => {
    const message = composeReminder(
      session({ deliveryWindowStart: null, deliveryWindowEnd: null, startTime: '09:30' }),
      true,
    );

    // 09:30 plus the fixture's 120-minute duration.
    expect(message).toContain('between 09:30 and 11:30');
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
    expect(
      composeReminder(session({ deliveryWindowStart: '13:00', deliveryWindowEnd: '15:00' }), true)
        .length,
    ).toBeLessThanOrEqual(160);
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
