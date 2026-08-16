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
 * The charity settled on 2026-08-15 that a referral cannot be cancelled once
 * its parcel has an attendance outcome — `INITIAL_SPEC1.txt`,
 * `#Referral maintenance`. `referrals.service.ts#cancel`,
 * `referrals.repository.ts#buildCancelReferralIfNoOutcome`.
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
  const response = await testApp.request(`/api/v1/parcels/${parcelId}/attendance`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ attendance }),
  });
  expect(response.status).toBe(200);
}

async function cancelReferral(
  testApp: TestApp,
  token: string,
  id: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request(`/api/v1/referrals/${id}/cancel`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  const body: Record<string, unknown> = await response.json();
  return { status: response.status, body };
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

describe('cancelling stops once an outcome exists', () => {
  it('still cancels a referral whose parcel is picked but pending', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    await generatePickList(testApp, token, w.sessionId);

    const { status, body } = await cancelReferral(testApp, token, id);

    expect(status).toBe(200);
    expect(body.status).toBe('cancelled');
  });

  it('refuses to cancel once the household has been marked attended, leaving the referral and the parcel untouched', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    await markAttendance(testApp, token, rows[0]?.id ?? '', 'attended');

    const { status, body } = await cancelReferral(testApp, token, id);

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: { code: 'CONFLICT' } });

    const [storedReferral] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(storedReferral?.status).toBe('active');
    expect(storedReferral?.cancelledAt).toBeNull();

    const [storedParcel] = await db.select().from(parcels).where(eq(parcels.referralId, id));
    expect(storedParcel?.attendance).toBe('attended');
  });

  it('refuses to cancel once the household has been marked no_show, leaving the referral and the parcel untouched', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    await markAttendance(testApp, token, rows[0]?.id ?? '', 'no_show');

    const { status, body } = await cancelReferral(testApp, token, id);

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: { code: 'CONFLICT' } });

    const [storedReferral] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(storedReferral?.status).toBe('active');
    expect(storedReferral?.cancelledAt).toBeNull();

    const [storedParcel] = await db.select().from(parcels).where(eq(parcels.referralId, id));
    expect(storedParcel?.attendance).toBe('no_show');
  });

  it('is still idempotent on an already-cancelled referral', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const first = await cancelReferral(testApp, token, id);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('cancelled');

    const second = await cancelReferral(testApp, token, id);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('cancelled');
  });
});
