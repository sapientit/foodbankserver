import { env } from 'cloudflare:workers';
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
import { voucherConfig } from '../src/db/schema/voucher-config.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  generatePickList,
  reviewEveryParcel,
  setUpPickingWorld,
  submitReferral,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

/**
 * `ParcelResponse.firstTimeMarker` and `ParcelResponse.voucherInstruction`
 * (`GET /sessions/{sessionId}/pick-list`, `GET /pick-lists/{id}`) —
 * `INITIAL_SPEC1.txt`, `#Christmas voucher and first-time selection`. Both are
 * for the Run a session screen; neither is on the printed sheet.
 * `setUpPickingWorld`'s session is dated `2026-08-11`, which the voucher-range
 * tests below deliberately straddle or exclude.
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

async function leadOf(testApp: TestApp): Promise<string> {
  const { accessToken } = await devLogin(testApp, {
    email: 'lead@foodbank.org',
    role: 'team_lead',
  });
  return accessToken;
}

async function setFirstTimeReview(
  testApp: TestApp,
  token: string,
  referralId: string,
  body: { noPreviousReferral: true } | { previousSessionDate: string },
): Promise<void> {
  const response = await testApp.request(`/api/v1/referrals/${referralId}/first-time-review`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

async function setVoucherRange(
  testApp: TestApp,
  token: string,
  range: { startDate: string; endDate: string },
): Promise<void> {
  const response = await testApp.request('/api/v1/voucher-config', {
    method: 'PUT',
    headers: json(token),
    body: JSON.stringify(range),
  });
  expect(response.status).toBe(200);
}

/** Three referrals, one in each first-time-review state. */
async function seedThreeStates(
  testApp: TestApp,
  token: string,
  w: PickingWorld,
): Promise<{ unreviewedId: string; noPreviousId: string; previousSessionId: string }> {
  const unreviewed = await submitReferral(testApp, w, {
    adults: 1,
    children: 0,
    refereeSurname: 'Ashdown',
  });
  const noPrevious = await submitReferral(testApp, w, {
    adults: 1,
    children: 0,
    refereeSurname: 'Bracken',
  });
  const previousSession = await submitReferral(testApp, w, {
    adults: 1,
    children: 0,
    refereeSurname: 'Cotswold',
  });

  await setFirstTimeReview(testApp, token, noPrevious.id, { noPreviousReferral: true });
  await setFirstTimeReview(testApp, token, previousSession.id, {
    previousSessionDate: '2026-08-05',
  });

  return {
    unreviewedId: unreviewed.id,
    noPreviousId: noPrevious.id,
    previousSessionId: previousSession.id,
  };
}

beforeEach(async () => {
  await db.delete(parcelLines);
  await db.delete(parcels);
  await db.delete(pickLists);
  await db.delete(modelParcels);
  await db.delete(parcelGrid);
  await db.delete(auditEvents);
  await db.delete(referrals);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(stockLedger);
  await db.delete(stockItems);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
  await db.delete(voucherConfig);
});

describe('Parcel.firstTimeMarker', () => {
  it('reflects all three referral states on GET /sessions/{sessionId}/pick-list and GET /pick-lists/{id}', async () => {
    const { testApp, token, world: w } = await world();
    const { unreviewedId, noPreviousId, previousSessionId } = await seedThreeStates(
      testApp,
      token,
      w,
    );

    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);

    for (const path of [
      `/api/v1/sessions/${w.sessionId}/pick-list`,
      `/api/v1/pick-lists/${pickListId}`,
    ]) {
      const response = await testApp.request(path, { headers: authHeaders(token) });
      const body: { parcels: { referralId: string; firstTimeMarker: string | null }[] } =
        await response.json();

      const byReferral = new Map(body.parcels.map((p) => [p.referralId, p.firstTimeMarker]));
      expect(byReferral.get(unreviewedId)).toBe('admin');
      expect(byReferral.get(noPreviousId)).toBe('first_time');
      expect(byReferral.get(previousSessionId)).toBeNull();
    }
  });

  it('is live-read rather than snapshotted at generation', async () => {
    const { testApp, token, world: w } = await world();
    const { id: referralId } = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);

    const before = await testApp.request(`/api/v1/pick-lists/${pickListId}`, {
      headers: authHeaders(token),
    });
    const beforeBody: { parcels: { referralId: string; firstTimeMarker: string | null }[] } =
      await before.json();
    expect(beforeBody.parcels.find((p) => p.referralId === referralId)?.firstTimeMarker).toBe(
      'admin',
    );

    // The decision is made *after* the pick list already exists.
    await setFirstTimeReview(testApp, token, referralId, { noPreviousReferral: true });

    const after = await testApp.request(`/api/v1/pick-lists/${pickListId}`, {
      headers: authHeaders(token),
    });
    const afterBody: { parcels: { referralId: string; firstTimeMarker: string | null }[] } =
      await after.json();
    expect(afterBody.parcels.find((p) => p.referralId === referralId)?.firstTimeMarker).toBe(
      'first_time',
    );
  });

  it('is visible to a team lead, not just an admin — the whole point of it being dateless', async () => {
    const { testApp, token, world: w } = await world();
    const { noPreviousId } = await seedThreeStates(testApp, token, w);
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const leadToken = await leadOf(testApp);

    const response = await testApp.request(`/api/v1/pick-lists/${pickListId}`, {
      headers: authHeaders(leadToken),
    });
    expect(response.status).toBe(200);
    const body: { parcels: { referralId: string; firstTimeMarker: string | null }[] } =
      await response.json();

    expect(body.parcels.find((p) => p.referralId === noPreviousId)?.firstTimeMarker).toBe(
      'first_time',
    );
  });
});

describe('Parcel.voucherInstruction', () => {
  async function instructionsByReferral(
    testApp: TestApp,
    token: string,
    path: string,
  ): Promise<Map<string, string | null>> {
    const response = await testApp.request(path, { headers: authHeaders(token) });
    expect(response.status).toBe(200);
    const body: { parcels: { referralId: string; voucherInstruction: string | null }[] } =
      await response.json();
    return new Map(body.parcels.map((p) => [p.referralId, p.voucherInstruction]));
  }

  it('gives the right instruction for each of the three states on both Run a session routes when the range includes the session date', async () => {
    const { testApp, token, world: w } = await world();
    const referrals3 = await seedThreeStates(testApp, token, w);
    await setVoucherRange(testApp, token, { startDate: '2026-08-01', endDate: '2026-08-20' });

    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);

    for (const path of [
      `/api/v1/sessions/${w.sessionId}/pick-list`,
      `/api/v1/pick-lists/${pickListId}`,
    ]) {
      const byReferral = await instructionsByReferral(testApp, token, path);

      expect(byReferral.get(referrals3.unreviewedId)).toBe('refer_to_admin');
      expect(byReferral.get(referrals3.noPreviousId)).toBe('provide_voucher');
      // Recorded date (2026-08-05) falls inside the configured range too.
      expect(byReferral.get(referrals3.previousSessionId)).toBe('already_received');
    }
  });

  it('is live-read rather than snapshotted at generation', async () => {
    const { testApp, token, world: w } = await world();
    const { id: referralId } = await submitReferral(testApp, w, { adults: 1, children: 0 });
    await setVoucherRange(testApp, token, { startDate: '2026-08-01', endDate: '2026-08-20' });

    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const path = `/api/v1/pick-lists/${pickListId}`;

    expect((await instructionsByReferral(testApp, token, path)).get(referralId)).toBe(
      'refer_to_admin',
    );

    // The decision is made *after* the pick list already exists.
    await setFirstTimeReview(testApp, token, referralId, { noPreviousReferral: true });

    expect((await instructionsByReferral(testApp, token, path)).get(referralId)).toBe(
      'provide_voucher',
    );
  });

  it('is null for every parcel when the configured range excludes the session date', async () => {
    const { testApp, token, world: w } = await world();
    await seedThreeStates(testApp, token, w);
    await setVoucherRange(testApp, token, { startDate: '2026-09-01', endDate: '2026-09-10' });

    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const byReferral = await instructionsByReferral(
      testApp,
      token,
      `/api/v1/pick-lists/${pickListId}`,
    );

    expect(byReferral.size).toBeGreaterThan(0);
    for (const instruction of byReferral.values()) {
      expect(instruction).toBeNull();
    }
  });

  it('is null for every parcel when no range has been configured at all', async () => {
    const { testApp, token, world: w } = await world();
    await seedThreeStates(testApp, token, w);

    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const byReferral = await instructionsByReferral(
      testApp,
      token,
      `/api/v1/pick-lists/${pickListId}`,
    );

    expect(byReferral.size).toBeGreaterThan(0);
    for (const instruction of byReferral.values()) {
      expect(instruction).toBeNull();
    }
  });

  it('is visible to a team lead on the Run a session screen, not just an admin', async () => {
    const { testApp, token, world: w } = await world();
    const { id: referralId } = await submitReferral(testApp, w, { adults: 1, children: 0 });
    await setFirstTimeReview(testApp, token, referralId, { noPreviousReferral: true });
    await setVoucherRange(testApp, token, { startDate: '2026-08-01', endDate: '2026-08-20' });

    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const leadToken = await leadOf(testApp);

    const byReferral = await instructionsByReferral(
      testApp,
      leadToken,
      `/api/v1/pick-lists/${pickListId}`,
    );
    expect(byReferral.get(referralId)).toBe('provide_voucher');
  });

  it('never leaks the historic previous-session date onto the Run a session screen', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, {
      adults: 1,
      children: 0,
      answers: { Dietary: 'no nuts' },
    });
    await setFirstTimeReview(testApp, token, referral.id, {
      previousSessionDate: '2025-11-30',
    });
    await setVoucherRange(testApp, token, { startDate: '2026-08-01', endDate: '2026-08-20' });

    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const response = await testApp.request(`/api/v1/pick-lists/${pickListId}`, {
      headers: authHeaders(token),
    });
    const text = await response.text();

    // The instruction is derived from the recorded date, but that date — which
    // falls outside the range, so the household still gets a voucher — never
    // reaches the screen, and neither does the reason for referral.
    expect(text).toContain('provide_voucher');
    expect(text).not.toContain('2025-11-30');
    expect(text).not.toContain(w.reasonId);
  });

  it('is no longer carried on the printed sheet', async () => {
    const { testApp, token, world: w } = await world();
    const { id: referralId } = await submitReferral(testApp, w, { adults: 1, children: 0 });
    await setFirstTimeReview(testApp, token, referralId, { noPreviousReferral: true });
    await setVoucherRange(testApp, token, { startDate: '2026-08-01', endDate: '2026-08-20' });

    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, pickListId);

    const response = await testApp.request(`/api/v1/pick-lists/${pickListId}/print`, {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);
    const body: { parcels: Record<string, unknown>[] } = await response.json();

    expect(body.parcels).not.toHaveLength(0);
    for (const parcel of body.parcels) {
      expect(parcel).not.toHaveProperty('voucherInstruction');
    }
  });
});
