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
import { voucherConfig } from '../src/db/schema/voucher-config.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  generatePickList,
  readPickList,
  setUpPickingWorld,
  submitReferral,
  UNKNOWN_REFERRER,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

/**
 * The listener sheet: the one place a team leader sees why a household was
 * referred.
 *
 * It is the most sensitive thing the system produces, so these tests are as
 * much about what it does **not** carry as what it does. It also now carries
 * a pick number for every household, and refuses outright rather than print
 * one with gaps in it — see the "pick numbers" describe block below.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

interface Household {
  referralId: string;
  pickNumber: number;
  refereeFirstName: string | null;
  refereeSurname: string | null;
  reason: string | null;
  needsFuelHelp: boolean;
  answers: Record<string, unknown>;
  firstTimeMarker: 'first_time' | 'admin' | null;
  voucherInstruction: 'provide_voucher' | 'already_received' | 'refer_to_admin' | null;
}

async function adminWorld(options: { deliveryCapacity?: number } = {}): Promise<{
  testApp: TestApp;
  token: string;
  world: PickingWorld;
}> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const world = await setUpPickingWorld(testApp, accessToken, options);
  return { testApp, token: accessToken, world };
}

async function readSheet(testApp: TestApp, token: string, sessionId: string) {
  const response = await testApp.request(`/api/v1/sessions/${sessionId}/listener-sheet`, {
    headers: authHeaders(token),
  });
  const body: {
    sessionId?: string;
    households?: Household[];
    error?: { code: string; message: string; details?: Record<string, unknown> };
  } = await response.json();
  return { status: response.status, ...body };
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

describe('the listener sheet', () => {
  it('carries the pick number, the name, the reason, the fuel flag and the answers', async () => {
    const { testApp, token, world } = await adminWorld();
    const referral = await submitReferral(testApp, world, {
      needsFuelHelp: true,
      answers: { 'Cause Details': 'Landlord sold the house', Dietary: 'no pork' },
    });
    await generatePickList(testApp, token, world.sessionId);

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.status).toBe(200);
    expect(sheet.households).toHaveLength(1);
    expect(sheet.households?.[0]).toEqual({
      referralId: referral.id,
      pickNumber: expect.any(Number),
      refereeFirstName: 'Alice',
      refereeSurname: 'Wintergreen',
      reason: 'Benefit delay',
      needsFuelHelp: true,
      // The whole map. **Cause Details is extracted by the client**, because
      // the client owns the form and the server holds no definition of it.
      answers: { 'Cause Details': 'Landlord sold the house', Dietary: 'no pork' },
      // This referral is unreviewed and no voucher range is configured: the
      // marker mirrors Parcel.firstTimeMarker, the instruction is absent.
      firstTimeMarker: 'admin',
      voucherInstruction: null,
    });
  });

  it('is readable by a team leader, which is the whole point of it', async () => {
    const { testApp, token, world } = await adminWorld();
    await submitReferral(testApp, world);
    await generatePickList(testApp, token, world.sessionId);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const sheet = await readSheet(lead, accessToken, world.sessionId);

    expect(sheet.status).toBe(200);
    expect(sheet.households?.[0]?.reason).toBe('Benefit delay');
    expect(token).toBeDefined();
  });

  it('still withholds the reason from a team leader everywhere else', async () => {
    // The listener sheet is an exception carved out of the rule, not the rule
    // being dropped. If this ever fails, the exception has leaked.
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await lead.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(accessToken),
    });
    const referral: Record<string, unknown> = await response.json();

    expect(referral).not.toHaveProperty('reasonId');
    expect(token).toBeDefined();
  });

  it('lists a household still awaiting review, because they may well turn up', async () => {
    const { testApp, token, world } = await adminWorld();
    await submitReferral(testApp, world, UNKNOWN_REFERRER);
    await generatePickList(testApp, token, world.sessionId);

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.households).toHaveLength(1);
  });

  it('lists a household whose referral has been read, exactly as it lists an unread one', async () => {
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world);

    const marked = await testApp.request(`/api/v1/referrals/${id}/review`, {
      method: 'POST',
      headers: json(token),
    });
    expect(marked.status).toBe(200);
    await generatePickList(testApp, token, world.sessionId);

    const sheet = await readSheet(testApp, token, world.sessionId);

    // Reading a referral is paperwork. The household is still coming, and a
    // listener with no line for them has nothing to work from.
    expect(sheet.households?.map((household) => household.referralId)).toEqual([id]);
  });

  it('leaves out a household that is not coming', async () => {
    // Handing a listener the name and the crisis of somebody who cancelled, or
    // whom the food bank turned away, is the harm this endpoint has to avoid.
    const { testApp, token, world } = await adminWorld();
    const coming = await submitReferral(testApp, world, {}, { clientIp: '203.0.113.1' });
    const cancelled = await submitReferral(testApp, world, {}, { clientIp: '203.0.113.2' });
    const rejected = await submitReferral(testApp, world, UNKNOWN_REFERRER, {
      clientIp: '203.0.113.3',
    });

    await testApp.request(`/api/v1/referrals/${cancelled.id}/cancel`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ reason: 'Found other help' }),
    });
    await testApp.request(`/api/v1/referrals/${rejected.id}/reject`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ comment: 'Not an authorised referrer' }),
    });
    // Neither the cancelled nor the rejected household is owed a parcel, so
    // neither blocks the sheet on a missing pick number.
    await generatePickList(testApp, token, world.sessionId);

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.status).toBe(200);
    expect(sheet.households?.map((household) => household.referralId)).toEqual([coming.id]);
  });

  it('leaves out a delivery, because nobody walks in for one', async () => {
    // A listener sheet is for the conversation that happens when somebody
    // arrives. A delivery household never arrives, so their name and their
    // crisis on a sheet carried round the hall exposes somebody who was never
    // going to be there.
    const { testApp, token, world } = await adminWorld({ deliveryCapacity: 1 });
    const collecting = await submitReferral(testApp, world, {}, { clientIp: '203.0.113.4' });
    const delivering = await submitReferral(
      testApp,
      world,
      { collectionMethod: 'delivery' },
      { clientIp: '203.0.113.5' },
    );
    expect(delivering.status).toBe(201);
    await generatePickList(testApp, token, world.sessionId);

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.status).toBe(200);
    expect(sheet.households?.map((household) => household.referralId)).toEqual([collecting.id]);
  });

  it('carries no address, postcode or phone number', async () => {
    // A minimised sheet: a listener needs to know what happened, not where
    // somebody lives.
    const { testApp, token, world } = await adminWorld();
    await submitReferral(testApp, world);
    await generatePickList(testApp, token, world.sessionId);

    const sheet = await readSheet(testApp, token, world.sessionId);
    const household = sheet.households?.[0] as unknown as Record<string, unknown>;

    for (const field of [
      'refereeAddress',
      'refereePostcode',
      'refereePhone',
      'refereeDateOfBirth',
      'referrerName',
      'referrerEmail',
      'reviewComment',
    ]) {
      expect(household).not.toHaveProperty(field);
    }
  });

  it('survives a purged referral rather than falling over on the nulls', async () => {
    const { testApp, token, world } = await adminWorld();
    const { id } = await submitReferral(testApp, world);
    await generatePickList(testApp, token, world.sessionId);

    await db
      .update(referrals)
      .set({
        refereeFirstName: null,
        refereeSurname: null,
        answersJson: null,
        piiPurgedAt: NOW,
      })
      .where(eq(referrals.id, id));

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.status).toBe(200);
    expect(sheet.households?.[0]).toMatchObject({
      refereeFirstName: null,
      refereeSurname: null,
      answers: {},
    });
  });

  it('reports an unknown session as missing', async () => {
    const { testApp, token } = await adminWorld();

    const sheet = await readSheet(testApp, token, crypto.randomUUID());

    expect(sheet.status).toBe(404);
  });

  it('is refused without a token', async () => {
    const { testApp, world } = await adminWorld();

    const response = await testApp.request(`/api/v1/sessions/${world.sessionId}/listener-sheet`);

    expect(response.status).toBe(401);
  });
});

describe('the listener sheet and pick numbers', () => {
  it('carries the same pick number as the picking sheet', async () => {
    const { testApp, token, world } = await adminWorld();
    const referral = await submitReferral(testApp, world);
    const { id: pickListId } = await generatePickList(testApp, token, world.sessionId);

    const { parcels: picked } = await readPickList(testApp, token, pickListId);
    const sheet = await readSheet(testApp, token, world.sessionId);

    const parcel = picked.find((one) => one.referralId === referral.id);
    expect(sheet.households?.[0]?.pickNumber).toBe(parcel?.pickNumber);
  });

  it('refuses with 409 NEW_CLIENTS_ASSIGNED when nobody has been picked for yet', async () => {
    // No pick list has ever been generated for this session, so the one
    // household on it has no pick number to print.
    const { testApp, token, world } = await adminWorld();
    const referral = await submitReferral(testApp, world);

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.status).toBe(409);
    expect(sheet.error?.code).toBe('NEW_CLIENTS_ASSIGNED');
    expect(sheet.error?.details?.missingParcels).toEqual([referral.id]);
    expect(sheet.households).toBeUndefined();
  });

  it('refuses with 409 NEW_CLIENTS_ASSIGNED when a referral arrives after the pick list was generated', async () => {
    const { testApp, token, world } = await adminWorld();
    await submitReferral(testApp, world, {}, { clientIp: '203.0.113.6' });
    await generatePickList(testApp, token, world.sessionId);

    // A household referred since the list was made — the food bank has not
    // picked for them, so the sheet cannot yet be matched to the picking
    // sheets by number.
    const late = await submitReferral(testApp, world, {}, { clientIp: '203.0.113.7' });

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.status).toBe(409);
    expect(sheet.error?.code).toBe('NEW_CLIENTS_ASSIGNED');
    expect(sheet.error?.details?.missingParcels).toEqual([late.id]);
  });

  it('is available again once the late arrival has been picked for too', async () => {
    const { testApp, token, world } = await adminWorld();
    await submitReferral(testApp, world, {}, { clientIp: '203.0.113.8' });
    await generatePickList(testApp, token, world.sessionId);
    await submitReferral(testApp, world, {}, { clientIp: '203.0.113.9' });

    // Reopening the session's pick list reconciles the late arrival.
    await generatePickList(testApp, token, world.sessionId);

    const sheet = await readSheet(testApp, token, world.sessionId);

    expect(sheet.status).toBe(200);
    expect(sheet.households).toHaveLength(2);
  });
});

describe('the listener sheet first-time marker and voucher instruction', () => {
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

  /**
   * Four households on the session dated 2026-08-11, one in each shape the
   * derivation cares about. Distinct surnames so the sheet's surname sort is
   * deterministic; results are mapped back by referral id regardless.
   */
  async function seedFourStates(
    testApp: TestApp,
    token: string,
    world: PickingWorld,
  ): Promise<{
    unreviewed: string;
    noPrevious: string;
    previousInRange: string;
    previousOutOfRange: string;
  }> {
    const unreviewed = await submitReferral(testApp, world, {
      adults: 1,
      children: 0,
      refereeSurname: 'Ashdown',
    });
    const noPrevious = await submitReferral(testApp, world, {
      adults: 1,
      children: 0,
      refereeSurname: 'Bracken',
    });
    const previousInRange = await submitReferral(testApp, world, {
      adults: 1,
      children: 0,
      refereeSurname: 'Cotswold',
    });
    const previousOutOfRange = await submitReferral(testApp, world, {
      adults: 1,
      children: 0,
      refereeSurname: 'Dashwood',
    });

    await setFirstTimeReview(testApp, token, noPrevious.id, { noPreviousReferral: true });
    // A recorded previous-session date that itself falls inside the voucher range.
    await setFirstTimeReview(testApp, token, previousInRange.id, {
      previousSessionDate: '2026-08-05',
    });
    // A recorded previous-session date well before any voucher range used here.
    await setFirstTimeReview(testApp, token, previousOutOfRange.id, {
      previousSessionDate: '2025-12-20',
    });

    return {
      unreviewed: unreviewed.id,
      noPrevious: noPrevious.id,
      previousInRange: previousInRange.id,
      previousOutOfRange: previousOutOfRange.id,
    };
  }

  async function markersByReferral(
    testApp: TestApp,
    token: string,
    sessionId: string,
  ): Promise<Map<string, { firstTimeMarker: string | null; voucherInstruction: string | null }>> {
    const sheet = await readSheet(testApp, token, sessionId);
    expect(sheet.status).toBe(200);
    return new Map(
      (sheet.households ?? []).map((h) => [
        h.referralId,
        { firstTimeMarker: h.firstTimeMarker, voucherInstruction: h.voucherInstruction },
      ]),
    );
  }

  it('carries only the first-time marker, mirroring Parcel.firstTimeMarker, when no voucher range is configured', async () => {
    const { testApp, token, world } = await adminWorld();
    const ids = await seedFourStates(testApp, token, world);
    await generatePickList(testApp, token, world.sessionId);

    const byReferral = await markersByReferral(testApp, token, world.sessionId);

    expect(byReferral.get(ids.unreviewed)).toEqual({
      firstTimeMarker: 'admin',
      voucherInstruction: null,
    });
    expect(byReferral.get(ids.noPrevious)).toEqual({
      firstTimeMarker: 'first_time',
      voucherInstruction: null,
    });
    expect(byReferral.get(ids.previousInRange)).toEqual({
      firstTimeMarker: null,
      voucherInstruction: null,
    });
    expect(byReferral.get(ids.previousOutOfRange)).toEqual({
      firstTimeMarker: null,
      voucherInstruction: null,
    });
  });

  it('leaves voucherInstruction null when the session date falls outside the configured voucher range', async () => {
    const { testApp, token, world } = await adminWorld();
    const ids = await seedFourStates(testApp, token, world);
    // Range is December 2026; the session is 2026-08-11, so no instruction belongs.
    await setVoucherRange(testApp, token, { startDate: '2026-12-01', endDate: '2026-12-31' });
    await generatePickList(testApp, token, world.sessionId);

    const byReferral = await markersByReferral(testApp, token, world.sessionId);

    for (const id of Object.values(ids)) {
      expect(byReferral.get(id)?.voucherInstruction).toBeNull();
    }
    expect(byReferral.get(ids.unreviewed)?.firstTimeMarker).toBe('admin');
    expect(byReferral.get(ids.noPrevious)?.firstTimeMarker).toBe('first_time');
  });

  it('carries the voucher instruction alongside the marker when the session is in range', async () => {
    const { testApp, token, world } = await adminWorld();
    const ids = await seedFourStates(testApp, token, world);
    await setVoucherRange(testApp, token, { startDate: '2026-08-01', endDate: '2026-08-31' });
    await generatePickList(testApp, token, world.sessionId);

    const byReferral = await markersByReferral(testApp, token, world.sessionId);

    expect(byReferral.get(ids.unreviewed)).toEqual({
      firstTimeMarker: 'admin',
      voucherInstruction: 'refer_to_admin',
    });
    expect(byReferral.get(ids.noPrevious)).toEqual({
      firstTimeMarker: 'first_time',
      voucherInstruction: 'provide_voucher',
    });
  });

  it('reports already_received only when the recorded previous-session date is itself in range', async () => {
    const { testApp, token, world } = await adminWorld();
    const ids = await seedFourStates(testApp, token, world);
    await setVoucherRange(testApp, token, { startDate: '2026-08-01', endDate: '2026-08-31' });
    await generatePickList(testApp, token, world.sessionId);

    const byReferral = await markersByReferral(testApp, token, world.sessionId);

    // Previous session 2026-08-05 is inside the range: the client has had one.
    expect(byReferral.get(ids.previousInRange)).toEqual({
      firstTimeMarker: null,
      voucherInstruction: 'already_received',
    });
    // Previous session 2025-12-20 is outside the range: treated as if new.
    expect(byReferral.get(ids.previousOutOfRange)).toEqual({
      firstTimeMarker: null,
      voucherInstruction: 'provide_voucher',
    });
  });

  it('exposes neither the historic previous-session date nor the raw review status', async () => {
    const { testApp, token, world } = await adminWorld();
    await seedFourStates(testApp, token, world);
    await setVoucherRange(testApp, token, { startDate: '2026-08-01', endDate: '2026-08-31' });
    await generatePickList(testApp, token, world.sessionId);

    const sheet = await readSheet(testApp, token, world.sessionId);
    const raw = JSON.stringify(sheet.households);

    expect(raw).not.toContain('2026-08-05');
    expect(raw).not.toContain('2025-12-20');
    expect(raw).not.toContain('previous_session');
    expect(raw).not.toContain('unreviewed');
    for (const household of sheet.households ?? []) {
      const record = household as unknown as Record<string, unknown>;
      expect(record).not.toHaveProperty('firstTimeReviewStatus');
      expect(record).not.toHaveProperty('firstTimeReviewDate');
    }
  });
});
