import { describe, expect, it } from 'vitest';
import { effectiveDeliveryWindow } from '../src/modules/sessions/delivery-window.ts';

/**
 * Pure and I/O-free, and read by both the response mapper (the public
 * session's effective window) and the SMS composer (a delivery reminder's
 * wording) — so this is the one place the fallback rule needs proving.
 */
describe('effectiveDeliveryWindow', () => {
  it('returns the stored pair when both ends are set, ignoring the session’s own hours', () => {
    const window = effectiveDeliveryWindow({
      startTime: '10:00',
      durationMinutes: 120,
      deliveryWindowStart: '13:00',
      deliveryWindowEnd: '15:00',
    });

    expect(window).toEqual({ start: '13:00', end: '15:00' });
  });

  it('falls back to the session’s own hours — start to start plus duration — when both ends are null', () => {
    const window = effectiveDeliveryWindow({
      startTime: '10:00',
      durationMinutes: 120,
      deliveryWindowStart: null,
      deliveryWindowEnd: null,
    });

    expect(window).toEqual({ start: '10:00', end: '12:00' });
  });

  it('wraps the fallback past midnight for a late session', () => {
    const window = effectiveDeliveryWindow({
      startTime: '23:00',
      durationMinutes: 120,
      deliveryWindowStart: null,
      deliveryWindowEnd: null,
    });

    expect(window).toEqual({ start: '23:00', end: '01:00' });
  });
});
