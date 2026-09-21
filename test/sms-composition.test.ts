import { describe, expect, it } from 'vitest';
import { composeReferrerReminder, composeReminder } from '../src/modules/sms/messages.ts';
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
    const message = composeReminder(session(), false, 'Alice');

    expect(message).toBe(
      'Hi Alice this is Guildford Food Bank. Please collect your parcel on Fri 14 Aug at 10:00 from Church Hall. Any problems let us know.',
    );
  });

  it('gives a delivered household the date and the stored delivery window and no place at all', () => {
    const message = composeReminder(
      session({ deliveryWindowStart: '13:00', deliveryWindowEnd: '15:00' }),
      true,
      'Alice',
    );

    expect(message).toBe(
      'Hi Alice this is Guildford Food Bank. Your parcel will be delivered on Fri 14 Aug, between 13:00 and 15:00. Someone must be home to receive it. Any problems let us know.',
    );
    expect(message).not.toContain('Church Hall');
  });

  it('falls back to the session’s own hours when it has no delivery window set', () => {
    const message = composeReminder(
      session({ deliveryWindowStart: null, deliveryWindowEnd: null, startTime: '09:30' }),
      true,
      'Alice',
    );

    // 09:30 plus the fixture's 120-minute duration.
    expect(message).toContain('between 09:30 and 11:30');
  });

  it('never carries an address on a delivery reminder', () => {
    // `composeReminder` takes a `Session`, a boolean and a first name — there
    // is no address input for one to leak in from, and this pins down the
    // one field a delivery message must never carry.
    const delivery = composeReminder(session({ location: '221B Baker Street' }), true, 'Alice');

    expect(delivery).not.toContain('Baker Street');
  });

  it('greets with the plain opener and no name when firstName is null', () => {
    const message = composeReminder(session(), false, null);

    expect(message).toBe(
      'This is Guildford Food Bank. Please collect your parcel on Fri 14 Aug at 10:00 from Church Hall. Any problems let us know.',
    );
    expect(message).not.toContain('Hi ');
  });

  it('stays within one SMS segment (160 GSM-7 characters) for a collection reminder', () => {
    expect(composeReminder(session(), false, 'Alice').length).toBeLessThanOrEqual(160);
  });

  it('is not trimmed to one segment for a delivery reminder — the fixed wording, personalised with a name, now runs to a second segment and `composeReminder` applies no `fitToLimit` here (delivery carries no location to trim)', () => {
    const message = composeReminder(
      session({ deliveryWindowStart: '13:00', deliveryWindowEnd: '15:00' }),
      true,
      'Alice',
    );
    expect(message.length).toBeGreaterThan(160);
  });

  it('truncates a long location rather than exceeding one segment', () => {
    const longLocation = 'A'.repeat(200);
    const message = composeReminder(session({ location: longLocation }), false, 'Alice');

    expect(message.length).toBeLessThanOrEqual(160);
    expect(message).toContain(
      'Hi Alice this is Guildford Food Bank. Please collect your parcel on Fri 14 Aug at 10:00 from',
    );
  });

  it('reads the same weekday and day regardless of the BST changeover', () => {
    // 27 October 2026 is the last Sunday of the month — the moment the clocks
    // go back. The session date is a plain calendar date, not an instant, so
    // this must not shift.
    const message = composeReminder(
      session({ sessionDate: '2026-10-27', startTime: '10:00' }),
      false,
      'Alice',
    );
    expect(message).toContain('Tue 27 Oct');
  });
});

describe('composeReferrerReminder', () => {
  it('greets the referrer by first name only and names the parcel as their client’s', () => {
    const message = composeReferrerReminder(session(), 'Jane Fieldsworth');

    expect(message).toBe(
      "Hi Jane this is Guildford Food Bank. Please collect your client's parcel as arranged on Fri 14 Aug at 10:00 from Church Hall. Any problems let us know.",
    );
  });

  it('falls back to the plain opener and no name when referrerName is null', () => {
    const message = composeReferrerReminder(session(), null);

    expect(message).toBe(
      "This is Guildford Food Bank. Please collect your client's parcel as arranged on Fri 14 Aug at 10:00 from Church Hall. Any problems let us know.",
    );
    expect(message).not.toContain('Hi ');
  });

  it('never reuses the collection or delivery wording verbatim', () => {
    const referrerMessage = composeReferrerReminder(session(), 'Jane Fieldsworth');
    const collectionMessage = composeReminder(session(), false, 'Jane');
    const deliveryMessage = composeReminder(session(), true, 'Jane');

    expect(referrerMessage).not.toBe(collectionMessage);
    expect(referrerMessage).not.toBe(deliveryMessage);
  });
});
