import { expect } from 'vitest';
import { authHeaders, type TestApp } from './app.ts';

/**
 * Shared setup for the referral tests: a session, a reason, a referrer.
 *
 * There is no form to set up. The referral form is client configuration, so the
 * server has nothing to publish and nothing to validate answers against.
 */
export interface ReferralWorld {
  readonly sessionId: string;
  readonly reasonId: string;
}

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

export async function setUpReferralWorld(
  testApp: TestApp,
  token: string,
  options: { capacity?: number } = {},
): Promise<ReferralWorld> {
  const session = await testApp.request('/api/v1/sessions', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      sessionDate: '2026-08-11',
      startTime: '10:00',
      durationMinutes: 120,
      location: 'Church Hall',
      capacity: options.capacity ?? 25,
    }),
  });
  expect(session.status).toBe(201);
  const { id: sessionId }: { id: string } = await session.json();

  const reason = await testApp.request('/api/v1/referral-reasons', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ code: 'benefit_delay', label: 'Benefit delay' }),
  });
  const { id: reasonId }: { id: string } = await reason.json();

  await testApp.request('/api/v1/authorised-referrers', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      matchType: 'domain',
      matchValue: '*@guildford.gov.uk',
      organisationName: 'Guildford Borough Council',
    }),
  });

  return { sessionId, reasonId };
}

/** A realistic submission body. Values here are asserted against in PII tests. */
export function submission(world: ReferralWorld, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: world.sessionId,
    reasonId: world.reasonId,
    referrerEmail: 'jane@guildford.gov.uk',
    referrerPhone: '01483 000111',
    refereeName: 'Alice Wintergreen',
    refereeAddress: '12 Bramble Cottages',
    refereePostcode: 'GU1 4AA',
    refereePhone: '07700 900123',
    adults: 2,
    children: 3,
    answers: { dietary_needs: 'no pork' },
    ...overrides,
  };
}

export async function submitReferral(
  testApp: TestApp,
  world: ReferralWorld,
  overrides: Record<string, unknown> = {},
  options: { clientIp?: string } = {},
): Promise<{ id: string; editKey: string; status: number; body: unknown }> {
  const response = await testApp.request('/api/v1/public/referrals', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Referral submission is rate limited per client address. A test seeding
      // many referrals is standing in for many different referrers, so it gets
      // a distinct address for each unless it asks to share one.
      ...(options.clientIp === undefined ? {} : { 'cf-connecting-ip': options.clientIp }),
    },
    body: JSON.stringify(submission(world, overrides)),
  });

  const body: unknown = await response.json();
  const parsed = body as { id?: string; editKey?: string };
  return {
    id: parsed.id ?? '',
    editKey: parsed.editKey ?? '',
    status: response.status,
    body,
  };
}

export function keyHeaders(editKey: string): Record<string, string> {
  return { 'x-referral-key': editKey, 'content-type': 'application/json' };
}
