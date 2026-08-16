import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import { submitReferral } from './helpers/referral-fixtures.ts';
import {
  generatePickList,
  readPickList,
  setUpPickingWorld,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

/**
 * `ReferralResponse.outcome` — what became of the *household*, distinct
 * from `status`, which is what became of the *referral*. Derived by
 * `outcomeFor` from the referral's parcels: `attended` if any parcel was
 * attended, else `no_show` if any was marked as not turning up, else
 * `booked`. `INITIAL_SPEC1.txt`, `#Referral maintenance`.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

async function world(): Promise<{ testApp: TestApp; token: string; world: PickingWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const built = await setUpPickingWorld(testApp, accessToken);
  return { testApp, token: accessToken, world: built };
}

async function getReferral(
  testApp: TestApp,
  token: string,
  id: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request(`/api/v1/referrals/${id}`, {
    headers: authHeaders(token),
  });
  const body: Record<string, unknown> = await response.json();
  return { status: response.status, body };
}

/** Reviews the parcel, then records the outcome — the same two-step flow
 *  `attendance.test.ts` uses, so `outcome` tests exercise the real prerequisite
 *  rather than a shortcut around it. */
async function markAttendance(
  testApp: TestApp,
  token: string,
  parcelId: string,
  attendance: 'attended' | 'no_show',
): Promise<void> {
  await testApp.request(`/api/v1/parcels/${parcelId}/review`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  await testApp.request(`/api/v1/parcels/${parcelId}/attendance`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ attendance }),
  });
}

beforeEach(async () => {
  await db.delete(stockLedger);
  await db.delete(parcelLines);
  await db.delete(parcels);
  await db.delete(pickLists);
  await db.delete(parcelGrid);
  await db.delete(modelParcels);
  await db.delete(auditEvents);
  await db.delete(referrals);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(stockItems);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('what became of the household', () => {
  it('reads "booked" when no pick list has been generated for the session', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const { status, body } = await getReferral(testApp, token, id);
    expect(status).toBe(200);
    expect(body.outcome).toBe('booked');
  });

  it('reads "booked" when a parcel exists but attendance is still pending', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    await generatePickList(testApp, token, w.sessionId);

    const { body } = await getReferral(testApp, token, id);
    expect(body.outcome).toBe('booked');
  });

  it('reads "attended" once the household is marked as having collected', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    await markAttendance(testApp, token, rows[0]?.id ?? '', 'attended');

    const { body } = await getReferral(testApp, token, id);
    // Marking attendance changes the parcel, not the referral's own status.
    expect(body).toMatchObject({ status: 'active', outcome: 'attended' });
  });

  it('reads "no_show" once the household is marked as not having turned up', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    await markAttendance(testApp, token, rows[0]?.id ?? '', 'no_show');

    const { body } = await getReferral(testApp, token, id);
    expect(body).toMatchObject({ status: 'active', outcome: 'no_show' });
  });

  it('reads status "cancelled" with outcome "booked" — the settled behaviour the charity was asked about', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    // A pick list is generated first, so the parcel behind this referral is
    // marked `attendance: 'cancelled'` rather than simply not existing — the
    // sharper case, since `deriveOutcome` has to fail to read that as an
    // outcome on the day rather than fall back to "nothing generated yet".
    await generatePickList(testApp, token, w.sessionId);

    const cancelled = await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(cancelled.status).toBe(200);

    const { body } = await getReferral(testApp, token, id);
    expect(body).toMatchObject({ status: 'cancelled', outcome: 'booked' });

    // Confirms the parcel really did settle to `cancelled`, not `pending` or
    // deleted — otherwise this test would pass for the wrong reason.
    const [parcel] = await db.select().from(parcels).where(eq(parcels.referralId, id));
    expect(parcel?.attendance).toBe('cancelled');
  });

  it('gives a team lead the outcome too — it is not admin-only', async () => {
    const { testApp, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await lead.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(accessToken),
    });
    expect(response.status).toBe(200);
    const body: Record<string, unknown> = await response.json();
    expect(body.outcome).toBe('booked');

    // Unaffected by the admin-only fields also being absent from this response.
    expect(body).not.toHaveProperty('reasonId');
  });

  it('does not appear on GET /referrals — a second query the list does not pay for', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w);
    await submitReferral(testApp, w, { refereeSurname: 'Ashby' });

    const response = await testApp.request('/api/v1/referrals', { headers: authHeaders(token) });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('"outcome"');

    const body: { referrals: Record<string, unknown>[] } = JSON.parse(text);
    expect(body.referrals.length).toBeGreaterThan(0);
    for (const referral of body.referrals) {
      expect(referral).not.toHaveProperty('outcome');
    }
  });
});
