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
import { submission, submitReferral, UNKNOWN_REFERRER } from './helpers/referral-fixtures.ts';
import {
  generatePickList,
  readPickList,
  setUpPickingWorld,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

/**
 * `POST /referrals/{id}/copy` — `INITIAL_SPEC1.txt`, `#Copying a referral`:
 * a household whose referral came to nothing gets a fresh referral on a
 * later session. Admin-only. `referrals.service.ts#copy`.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

async function world(
  options: { deliveryCapacity?: number } = {},
): Promise<{ testApp: TestApp; token: string; world: PickingWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const built = await setUpPickingWorld(testApp, accessToken, options);
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

async function copyReferral(
  testApp: TestApp,
  token: string,
  id: string,
  body: { sessionId: string; acknowledgeOverCapacity?: boolean },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request(`/api/v1/referrals/${id}/copy`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
  const parsed: Record<string, unknown> = await response.json();
  return { status: response.status, body: parsed };
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

async function createSession(
  testApp: TestApp,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await testApp.request('/api/v1/sessions', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      sessionDate: '2026-08-18',
      startTime: '10:00',
      durationMinutes: 120,
      location: 'Annexe',
      capacity: 25,
      deliveryCapacity: 25,
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  const { id }: { id: string } = await response.json();
  return id;
}

async function cancelSession(testApp: TestApp, token: string, id: string): Promise<void> {
  const response = await testApp.request(`/api/v1/sessions/${id}/cancel`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
}

async function confirmSession(testApp: TestApp, token: string, id: string): Promise<void> {
  const response = await testApp.request(`/api/v1/sessions/${id}/confirm`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  expect(response.status).toBe(200);
}

/** A referral that has been rejected — one of the three eligible starting
 *  points, and the cheapest to set up (no pick list required). */
async function rejectedOriginal(
  testApp: TestApp,
  token: string,
  w: PickingWorld,
  overrides: Record<string, unknown> = {},
  comment = 'Not a referring organisation',
): Promise<string> {
  const { id } = await submitReferral(testApp, w, { ...UNKNOWN_REFERRER, ...overrides });
  const response = await testApp.request(`/api/v1/referrals/${id}/reject`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ comment }),
  });
  expect(response.status).toBe(200);
  return id;
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

describe('eligibility — offered only where the original can no longer come to anything', () => {
  it('succeeds for a cancelled original', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const target = await createSession(testApp, token);
    const { status } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(201);
  });

  it('succeeds for a rejected original', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);

    const target = await createSession(testApp, token);
    const { status } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(201);
  });

  it('succeeds for an active referral whose parcel was marked no_show', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    await markAttendance(testApp, token, rows[0]?.id ?? '', 'no_show');

    const target = await createSession(testApp, token);
    const { status } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(201);
  });

  it('refuses a referral still pending review', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, UNKNOWN_REFERRER);

    const target = await createSession(testApp, token);
    const { status } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(409);
  });

  it('refuses an active referral with no outcome', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);

    const target = await createSession(testApp, token);
    const { status } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(409);
  });

  it('refuses a reviewed referral with no outcome', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    await testApp.request(`/api/v1/referrals/${id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const target = await createSession(testApp, token);
    const { status } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(409);
  });

  it('refuses a referral whose household already collected', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    await markAttendance(testApp, token, rows[0]?.id ?? '', 'attended');

    const target = await createSession(testApp, token);
    const { status } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(409);
  });

  it('refuses a cancelled referral whose household had already collected', async () => {
    // **The legacy row, and the reason the `attended` check comes before the
    // status check.** Cancelling a household who had already collected was
    // allowed until the charity stopped it on 2026-08-15, and it deliberately
    // kept the recorded outcome — so `status: 'cancelled'` beside an
    // `attended` parcel is a shape that exists in the database today. On the
    // status test alone it would read as copy-eligible, and the food bank
    // would hand a second parcel to a household that had already been fed.
    //
    // The cancellation is written straight to the row because the API now
    // refuses it, which is the whole point: this state can no longer be
    // created, only inherited.
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    await markAttendance(testApp, token, rows[0]?.id ?? '', 'attended');

    await db
      .update(referrals)
      .set({ status: 'cancelled', cancelledAt: NOW, cancelledReason: null })
      .where(eq(referrals.id, id));

    const target = await createSession(testApp, token);
    const { status } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(409);

    // Nothing was created on the target session.
    const created = await db.select().from(referrals).where(eq(referrals.sessionId, target));
    expect(created).toHaveLength(0);
  });

  it('refuses a team lead outright', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);
    const target = await createSession(testApp, token);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await lead.request(`/api/v1/referrals/${id}/copy`, {
      method: 'POST',
      headers: json(accessToken),
      body: JSON.stringify({ sessionId: target }),
    });
    expect(response.status).toBe(403);
  });
});

describe('what the copy carries', () => {
  it('carries the household, the referrer and the answers, but not the review comment', async () => {
    const { testApp, token, world: w } = await world({ deliveryCapacity: 5 });
    const comment = 'Not a referring organisation';
    const id = await rejectedOriginal(
      testApp,
      token,
      w,
      { adults: 4, children: 1, isDelivery: true, needsFuelHelp: true },
      comment,
    );
    const target = await createSession(testApp, token);

    const { status, body: copy } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(201);

    const source = submission(w, {
      ...UNKNOWN_REFERRER,
      adults: 4,
      children: 1,
      isDelivery: true,
      needsFuelHelp: true,
    });
    expect(copy).toMatchObject({
      refereeFirstName: source.refereeFirstName,
      refereeSurname: source.refereeSurname,
      refereeDateOfBirth: source.refereeDateOfBirth,
      refereeAddress: source.refereeAddress,
      refereePostcode: source.refereePostcode,
      refereePhone: source.refereePhone,
      adults: 4,
      children: 1,
      householdSize: 5,
      isDelivery: true,
      needsFuelHelp: true,
      reasonId: w.reasonId,
      answers: source.answers,
      referrerName: source.referrerName,
      referrerOrganisation: UNKNOWN_REFERRER.referrerOrganisation,
      referrerEmail: UNKNOWN_REFERRER.referrerEmail,
      referrerPhone: source.referrerPhone,
    });

    // Not carried: the copy has nothing to say about a decision it never made.
    expect(copy.reviewComment).toBeNull();

    // The original keeps its own comment and its rejected status.
    const [storedOriginal] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(storedOriginal?.status).toBe('rejected');
    expect(storedOriginal?.reviewComment).toBe(comment);
  });

  it('puts the copy on the new session, leaving the original where it was; the copy is reviewed with no parcel of its own', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);
    const target = await createSession(testApp, token);

    const { status, body: copy } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(201);
    expect(copy).toMatchObject({ sessionId: target, status: 'reviewed', outcome: 'booked' });

    const [storedOriginal] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(storedOriginal?.sessionId).toBe(w.sessionId);

    // "Copying makes no parcel. The copy... is picked for in the ordinary way,
    // when the picking list for that session is made" — INITIAL_SPEC1.txt.
    // Generating the pick list for the new session is therefore the proof
    // both that there was no parcel yet and that one is made in the ordinary
    // way once picking runs.
    const generated = await generatePickList(testApp, token, target);
    expect(generated.parcelsCreated).toBe(1);
    const { parcels: rows } = await readPickList(testApp, token, generated.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.referralId).toBe(copy.id);
  });

  it('names the original and its referral date in the note, replacing any note the original had — straddling the BST/GMT boundary', async () => {
    const { testApp, token, world: w } = await world();
    // Held for review rather than rejected straight away: the note has to be
    // written while the referral is still amendable, and a rejected referral
    // is refused amendment — `assertOpenToChange`.
    const { id } = await submitReferral(testApp, w, UNKNOWN_REFERRER);

    // Give the original its own note, to prove the copy's note replaces it
    // rather than extending it.
    const noted = await testApp.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ adminInfo: 'ADMIN NOTE: rang about the gas card' }),
    });
    expect(noted.status).toBe(200);

    const rejected = await testApp.request(`/api/v1/referrals/${id}/reject`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ comment: 'Not a referring organisation' }),
    });
    expect(rejected.status).toBe(200);

    // London is on BST (UTC+1) in August, so 23:30 UTC on the 20th is 00:30
    // the next day in London — the date this test exists to catch a bug on.
    const originalReferredAt = '2026-08-20T23:30:00.000Z';
    await db.update(referrals).set({ referredAt: originalReferredAt }).where(eq(referrals.id, id));

    const target = await createSession(testApp, token);

    // A different "now" for the copy itself, **on a different London day from
    // the original's**. Both halves of that matter: the original converts to
    // 2026-08-21 in London and 2026-08-20 in UTC, so the note catches a naive
    // UTC read; and the copy is made on 2026-08-22, so the note would also
    // fail if the code used `now` rather than the original's `referredAt`.
    const copyApp = buildTestApp({ clock: fixedClock('2026-08-22T12:00:00.000Z') });
    const { accessToken: copyToken } = await devLogin(copyApp, { email: 'admin@foodbank.org' });

    const { status, body: copy } = await copyReferral(copyApp, copyToken, id, {
      sessionId: target,
    });
    expect(status).toBe(201);

    // London, not UTC (which would say the 20th), and the original's date, not
    // the copy's (which would say the 22nd).
    expect(copy.adminInfo).toBe('Copied from referral dated 2026-08-21');
    expect(copy.adminInfo).not.toContain('gas card');

    expect(copy.referredAt).toBe('2026-08-22T12:00:00.000Z');
    expect(copy.referredAt).not.toBe(originalReferredAt);
  });

  it('leaves the original completely untouched — status, session, parcel and attendance', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w);
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    const parcelId = rows[0]?.id ?? '';
    await markAttendance(testApp, token, parcelId, 'no_show');

    const before = await getReferral(testApp, token, id);
    const [parcelBefore] = await db.select().from(parcels).where(eq(parcels.id, parcelId));

    const target = await createSession(testApp, token);
    const { status } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(201);

    const after = await getReferral(testApp, token, id);
    expect(after.body).toMatchObject({
      status: before.body.status,
      sessionId: before.body.sessionId,
      outcome: before.body.outcome,
    });

    const [parcelAfter] = await db.select().from(parcels).where(eq(parcels.id, parcelId));
    expect(parcelAfter).toMatchObject({
      attendance: parcelBefore?.attendance,
      pickNumber: parcelBefore?.pickNumber,
      referralId: parcelBefore?.referralId,
    });
  });

  it('carries the reason for referral even after the charity retires it', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);

    const deactivated = await testApp.request(`/api/v1/referral-reasons/${w.reasonId}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ isActive: false }),
    });
    expect(deactivated.status).toBe(200);

    const target = await createSession(testApp, token);
    const { status, body: copy } = await copyReferral(testApp, token, id, { sessionId: target });

    expect(status).toBe(201);
    expect(copy.reasonId).toBe(w.reasonId);
  });
});

describe('the target session — the same rules as a move', () => {
  it('refuses a cancelled target session', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);
    const target = await createSession(testApp, token);
    await cancelSession(testApp, token, target);

    const { status } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(409);
  });

  it('refuses a confirmed target session', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);
    const target = await createSession(testApp, token);
    await confirmSession(testApp, token, target);

    const { status } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(409);
  });

  it('refuses a full target session without acknowledgement, and accepts it with', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);
    const target = await createSession(testApp, token, { capacity: 0, deliveryCapacity: 0 });

    const refused = await copyReferral(testApp, token, id, { sessionId: target });
    expect(refused.status).toBe(409);

    const allowed = await copyReferral(testApp, token, id, {
      sessionId: target,
      acknowledgeOverCapacity: true,
    });
    expect(allowed.status).toBe(201);
  });

  it('404s on a target session that does not exist', async () => {
    const { testApp, token, world: w } = await world();
    const id = await rejectedOriginal(testApp, token, w);

    const { status } = await copyReferral(testApp, token, id, { sessionId: crypto.randomUUID() });
    expect(status).toBe(404);
  });
});
