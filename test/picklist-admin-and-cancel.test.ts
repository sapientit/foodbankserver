import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { MAX_PICKLIST_ADMIN_LENGTH } from '../src/config/constants.ts';
import { createDatabase } from '../src/db/client.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  setUpReferralWorld,
  submission,
  submitReferral,
  UNKNOWN_REFERRER,
  type ReferralWorld,
} from './helpers/referral-fixtures.ts';
import {
  generatePickList,
  readPickList,
  reviewEveryParcel,
  setUpPickingWorld,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

/**
 * Three server changes, covered together because all three touch the same
 * referral row:
 *
 * - `Referral.picklistAdmin` / `Parcel.picklistAdmin` — migration `0045`.
 * - `POST /referrals/{id}/cancel`'s body is now `{ adminInfo }`, not
 *   `{ reason }` — migration `0044` drops the column the old field wrote to.
 * - Migration `0045`'s one-off backfill of `parcels.notes` to `NULL`.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';
const NOTE = 'Ring ahead: gate code changed';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

let clientIpCounter = 0;
function nextClientIp(): string {
  clientIpCounter += 1;
  return `203.0.117.${String(clientIpCounter)}`;
}

async function adminWorld(): Promise<{ testApp: TestApp; token: string; world: ReferralWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const world = await setUpReferralWorld(testApp, accessToken);
  return { testApp, token: accessToken, world };
}

async function pickingWorld(): Promise<{ testApp: TestApp; token: string; world: PickingWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const world = await setUpPickingWorld(testApp, accessToken);
  return { testApp, token: accessToken, world };
}

async function patchReferral(
  testApp: TestApp,
  token: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request(`/api/v1/referrals/${id}`, {
    method: 'PATCH',
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
  const parsed: Record<string, unknown> = await response.json();
  return { status: response.status, body: parsed };
}

async function cancelReferral(
  testApp: TestApp,
  token: string,
  id: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request(`/api/v1/referrals/${id}/cancel`, {
    method: 'POST',
    ...(body === undefined
      ? { headers: authHeaders(token) }
      : { headers: json(token), body: JSON.stringify(body) }),
  });
  const parsed: Record<string, unknown> = await response.json();
  return { status: response.status, body: parsed };
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

async function reReferReferral(
  testApp: TestApp,
  token: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await testApp.request(`/api/v1/referrals/${id}/re-refer`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
  const parsed: Record<string, unknown> = await response.json();
  return { status: response.status, body: parsed };
}

/** A referral that has been rejected — the cheapest eligible starting point for a copy. */
async function rejectedOriginal(
  testApp: TestApp,
  token: string,
  w: ReferralWorld,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { id } = await submitReferral(testApp, w, { ...UNKNOWN_REFERRER, ...overrides });
  const response = await testApp.request(`/api/v1/referrals/${id}/reject`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ comment: 'Not a referring organisation' }),
  });
  expect(response.status).toBe(200);
  return id;
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

async function confirmSessionDirectly(sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ status: 'confirmed', confirmedAt: NOW, updatedAt: NOW })
    .where(eq(sessions.id, sessionId));
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

describe('picklistAdmin on the referral — set, replace, clear, leave alone', () => {
  it('sets it on PATCH and GET carries it too', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const patched = await patchReferral(testApp, token, id, { picklistAdmin: NOTE });
    expect(patched.status).toBe(200);
    expect(patched.body.picklistAdmin).toBe(NOTE);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.picklistAdmin).toBe(NOTE);

    const fetched = await getReferral(testApp, token, id);
    expect(fetched.body.picklistAdmin).toBe(NOTE);
  });

  it('replaces it on a second PATCH', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    await patchReferral(testApp, token, id, { picklistAdmin: NOTE });
    const replaced = await patchReferral(testApp, token, id, {
      picklistAdmin: 'Use the side door',
    });

    expect(replaced.status).toBe(200);
    expect(replaced.body.picklistAdmin).toBe('Use the side door');
  });

  it('clears it to null on an explicit null', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { picklistAdmin: NOTE });

    const cleared = await patchReferral(testApp, token, id, { picklistAdmin: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.picklistAdmin).toBeNull();

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.picklistAdmin).toBeNull();
  });

  it('leaves it untouched when a PATCH omits the key entirely', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { picklistAdmin: NOTE });

    const patched = await patchReferral(testApp, token, id, { refereeSurname: 'Wintergreene' });
    expect(patched.status).toBe(200);
    expect(patched.body.picklistAdmin).toBe(NOTE);
  });

  it('does not disturb adminInfo, and adminInfo does not disturb it', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    await patchReferral(testApp, token, id, { adminInfo: 'ADMIN NOTE: rang the office' });
    const patched = await patchReferral(testApp, token, id, { picklistAdmin: NOTE });
    expect(patched.status).toBe(200);
    expect(patched.body.adminInfo).toBe('ADMIN NOTE: rang the office');
    expect(patched.body.picklistAdmin).toBe(NOTE);

    const again = await patchReferral(testApp, token, id, { adminInfo: 'Follow-up done' });
    expect(again.body.picklistAdmin).toBe(NOTE);
  });
});

describe('picklistAdmin validation — the same rules as adminInfo', () => {
  it('refuses an empty string with 400 and writes nothing', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const response = await patchReferral(testApp, token, id, { picklistAdmin: '' });
    expect(response.status).toBe(400);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.picklistAdmin).toBeNull();
  });

  it('refuses whitespace-only text with 400, since it is trimmed first', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const response = await patchReferral(testApp, token, id, { picklistAdmin: '   ' });
    expect(response.status).toBe(400);
  });

  it('accepts exactly 400 characters and refuses 401, storing it trimmed', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    expect(MAX_PICKLIST_ADMIN_LENGTH).toBe(400);

    const atLimit = await patchReferral(testApp, token, id, {
      picklistAdmin: `  ${'a'.repeat(MAX_PICKLIST_ADMIN_LENGTH)}  `,
    });
    expect(atLimit.status).toBe(200);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.picklistAdmin).toBe('a'.repeat(MAX_PICKLIST_ADMIN_LENGTH));
    expect(stored?.picklistAdmin?.length).toBe(MAX_PICKLIST_ADMIN_LENGTH);

    const overLimit = await patchReferral(testApp, token, id, {
      picklistAdmin: 'a'.repeat(MAX_PICKLIST_ADMIN_LENGTH + 1),
    });
    expect(overLimit.status).toBe(400);

    const [afterRefusal] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(afterRefusal?.picklistAdmin?.length).toBe(MAX_PICKLIST_ADMIN_LENGTH);
  });
});

describe('picklistAdmin is locked exactly as adminInfo is', () => {
  it('refuses a PATCH on a rejected referral with 409, and writes nothing', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const id = await rejectedOriginal(testApp, token, w);

    const response = await patchReferral(testApp, token, id, { picklistAdmin: NOTE });
    expect(response.status).toBe(409);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.picklistAdmin).toBeNull();
  });

  it('refuses a PATCH on a cancelled referral with 409, and writes nothing', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const response = await patchReferral(testApp, token, id, { picklistAdmin: NOTE });
    expect(response.status).toBe(409);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.picklistAdmin).toBeNull();
  });

  it('refuses a PATCH on a referral whose session has been confirmed, and writes nothing', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await confirmSessionDirectly(w.sessionId);

    const response = await patchReferral(testApp, token, id, { picklistAdmin: NOTE });
    expect(response.status).toBe(409);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.picklistAdmin).toBeNull();
  });
});

describe('picklistAdmin appears exactly where adminInfo does, on the referral', () => {
  it('is on GET, PATCH, accept, review and cancel, and on reject too', async () => {
    const { testApp, token, world: w } = await adminWorld();

    const held = await submitReferral(testApp, w, UNKNOWN_REFERRER, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, held.id, { picklistAdmin: NOTE });

    const accepted = await testApp.request(`/api/v1/referrals/${held.id}/accept`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody: Record<string, unknown> = await accepted.json();
    expect(acceptedBody.picklistAdmin).toBe(NOTE);

    const reviewed = await testApp.request(`/api/v1/referrals/${held.id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(reviewed.status).toBe(200);
    const reviewedBody: Record<string, unknown> = await reviewed.json();
    expect(reviewedBody.picklistAdmin).toBe(NOTE);

    const cancelled = await testApp.request(`/api/v1/referrals/${held.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(cancelled.status).toBe(200);
    const cancelledBody: Record<string, unknown> = await cancelled.json();
    expect(cancelledBody.picklistAdmin).toBe(NOTE);

    const turnedAway = await submitReferral(testApp, w, UNKNOWN_REFERRER, {
      clientIp: nextClientIp(),
    });
    await patchReferral(testApp, token, turnedAway.id, { picklistAdmin: NOTE });
    const rejected = await testApp.request(`/api/v1/referrals/${turnedAway.id}/reject`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(rejected.status).toBe(200);
    const rejectedBody: Record<string, unknown> = await rejected.json();
    expect(rejectedBody.picklistAdmin).toBe(NOTE);
  });

  it('is absent, not null, from GET /referrals/{id} for a team lead', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { picklistAdmin: NOTE });

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: leadToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });
    const response = await lead.request(`/api/v1/referrals/${id}`, {
      headers: authHeaders(leadToken),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('picklistAdmin');
    expect(text).not.toContain(NOTE);

    const asAdmin = await getReferral(testApp, token, id);
    expect(asAdmin.body.picklistAdmin).toBe(NOTE);
  });

  it('is absent from GET /referrals (the list), for an admin too', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { picklistAdmin: NOTE });

    const response = await testApp.request('/api/v1/referrals', { headers: authHeaders(token) });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('picklistAdmin');
    expect(text).not.toContain(NOTE);
    expect(text).toContain(id);
  });

  it('is absent from POST /referrals/search', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU46 3CC' },
      { clientIp: nextClientIp() },
    );
    await patchReferral(testApp, token, id, { picklistAdmin: NOTE });

    const response = await testApp.request('/api/v1/referrals/search', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ postcode: 'GU46 3CC' }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('picklistAdmin');
    expect(text).not.toContain(NOTE);
    expect(text).toContain(id);
  });
});

describe('picklistAdmin on the parcel', () => {
  it('is required and nullable, null when unset, and reaches a team lead too', async () => {
    const { testApp, token, world: w } = await pickingWorld();
    const { id } = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: leadToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    for (const [app, leadOrAdminToken] of [
      [testApp, token],
      [lead, leadToken],
    ] as const) {
      const response = await app.request(`/api/v1/pick-lists/${pickListId}`, {
        headers: authHeaders(leadOrAdminToken),
      });
      expect(response.status).toBe(200);
      const body: { parcels: { referralId: string; picklistAdmin: string | null }[] } =
        await response.json();
      const parcel = body.parcels.find((p) => p.referralId === id);
      expect(parcel).toHaveProperty('picklistAdmin');
      expect(parcel?.picklistAdmin).toBeNull();
    }
  });

  it('carries the note once the referral has one, on both pick-list routes', async () => {
    const { testApp, token, world: w } = await pickingWorld();
    const { id } = await submitReferral(testApp, w, { adults: 1, children: 0 });
    await patchReferral(testApp, token, id, { picklistAdmin: NOTE });
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);

    for (const path of [
      `/api/v1/pick-lists/${pickListId}`,
      `/api/v1/sessions/${w.sessionId}/pick-list`,
    ]) {
      const response = await testApp.request(path, { headers: authHeaders(token) });
      const body: { parcels: { referralId: string; picklistAdmin: string | null }[] } =
        await response.json();
      const parcel = body.parcels.find((p) => p.referralId === id);
      expect(parcel?.picklistAdmin).toBe(NOTE);
    }
  });

  it('is read live: amending it after generation changes what the parcel shows', async () => {
    const { testApp, token, world: w } = await pickingWorld();
    const { id } = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);

    const before = await readPickList(testApp, token, pickListId);
    const beforeParcel = (
      before as unknown as { parcels: { referralId: string; picklistAdmin: string | null }[] }
    ).parcels.find((p) => p.referralId === id);
    expect(beforeParcel?.picklistAdmin).toBeNull();

    const patched = await patchReferral(testApp, token, id, { picklistAdmin: NOTE });
    expect(patched.status).toBe(200);

    const afterResponse = await testApp.request(`/api/v1/pick-lists/${pickListId}`, {
      headers: authHeaders(token),
    });
    const after: { parcels: { referralId: string; picklistAdmin: string | null }[] } =
      await afterResponse.json();
    const afterParcel = after.parcels.find((p) => p.referralId === id);
    expect(afterParcel?.picklistAdmin).toBe(NOTE);
  });

  it('is absent from the printed sheet', async () => {
    const { testApp, token, world: w } = await pickingWorld();
    const { id } = await submitReferral(testApp, w, { adults: 1, children: 0 });
    await patchReferral(testApp, token, id, { picklistAdmin: NOTE });
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, pickListId);

    const printed = await testApp.request(`/api/v1/pick-lists/${pickListId}/print`, {
      headers: authHeaders(token),
    });
    expect(printed.status).toBe(200);
    const text = await printed.text();
    expect(text).not.toContain('picklistAdmin');
    expect(text).not.toContain(NOTE);
  });
});

describe('copy and re-refer carry picklistAdmin across', () => {
  it('the copy carries the source picklistAdmin, not its generated adminInfo note', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, UNKNOWN_REFERRER, {
      clientIp: nextClientIp(),
    });
    // Set while the referral is still open to change — rejecting locks it.
    await patchReferral(testApp, token, id, { picklistAdmin: NOTE });
    const rejected = await testApp.request(`/api/v1/referrals/${id}/reject`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ comment: 'Not a referring organisation' }),
    });
    expect(rejected.status).toBe(200);

    const target = await createSession(testApp, token);
    const { status, body: copy } = await copyReferral(testApp, token, id, { sessionId: target });
    expect(status).toBe(201);
    expect(copy.picklistAdmin).toBe(NOTE);

    // The generated note on the copy's `adminInfo` is unrelated to the
    // picker's line: the copy must not confuse the two.
    expect(copy.adminInfo).not.toBe(NOTE);
  });

  it('re-refer carries the source picklistAdmin across too', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, UNKNOWN_REFERRER, {
      clientIp: nextClientIp(),
    });
    // Set while the referral is still open to change — rejecting locks it.
    await patchReferral(testApp, token, id, { picklistAdmin: NOTE });
    const rejected = await testApp.request(`/api/v1/referrals/${id}/reject`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ comment: 'Not a referring organisation' }),
    });
    expect(rejected.status).toBe(200);

    const target = await createSession(testApp, token);
    const source = submission(w, UNKNOWN_REFERRER);
    const { status, body: created } = await reReferReferral(testApp, token, id, {
      sessionId: target,
      reasonId: w.reasonId,
      refereeFirstName: source.refereeFirstName,
      refereeSurname: source.refereeSurname,
      refereeDateOfBirth: source.refereeDateOfBirth,
      refereeAddress: source.refereeAddress,
      refereePostcode: source.refereePostcode,
      refereePhone: source.refereePhone,
      adults: 1,
      children: 0,
      collectionMethod: 'collection',
      answers: {},
    });
    expect(status).toBe(201);
    expect(created.picklistAdmin).toBe(NOTE);
  });
});

describe('the amend audit row names picklistAdmin but never its value', () => {
  it('records the field name only', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    await patchReferral(testApp, token, id, { picklistAdmin: NOTE });

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    const amended = audit.find((row) => row.action === 'amended');

    expect(amended?.detailJson).toContain('picklistAdmin');
    expect(amended?.detailJson).not.toContain(NOTE);
  });
});

describe('POST /referrals/{id}/cancel — the new {adminInfo} body', () => {
  it('replaces adminInfo in the same write as cancelling, and the response carries it', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const cancelled = await cancelReferral(testApp, token, id, { adminInfo: NOTE });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.adminInfo).toBe(NOTE);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).toBe('cancelled');
    expect(stored?.adminInfo).toBe(NOTE);
  });

  it('null clears the note while cancelling', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { adminInfo: 'Original note' });

    const cancelled = await cancelReferral(testApp, token, id, { adminInfo: null });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.adminInfo).toBeNull();

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adminInfo).toBeNull();
  });

  it('omitting adminInfo, or sending no body at all, leaves the existing note untouched', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { adminInfo: 'Keep me' });

    const cancelled = await cancelReferral(testApp, token, id);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.adminInfo).toBe('Keep me');

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adminInfo).toBe('Keep me');
  });

  it('refuses an empty-string adminInfo with 400, and does not cancel', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const response = await cancelReferral(testApp, token, id, { adminInfo: '' });
    expect(response.status).toBe(400);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).not.toBe('cancelled');
  });

  it('accepts a legacy {"reason": ...} body, cancels, and writes the reason nowhere', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { adminInfo: 'Keep me too' });

    const response = await testApp.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ reason: 'No longer needed' }),
    });
    expect(response.status).toBe(200);
    const body: Record<string, unknown> = await response.json();
    expect(body.status).toBe('cancelled');

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.status).toBe('cancelled');
    // The note is untouched — a legacy body is accepted, not acted on.
    expect(stored?.adminInfo).toBe('Keep me too');
    // There is nowhere left for a cancellation reason to be stored: the
    // column was dropped by migration 0044.
    expect(stored).not.toHaveProperty('cancelledReason');
  });

  describe('a refused cancel writes no note', () => {
    it('refuses a referral whose parcel already has an attendance outcome, and leaves the note alone', async () => {
      const { testApp, token, world: w } = await pickingWorld();
      const { id } = await submitReferral(testApp, w, { adults: 1, children: 0 });
      await patchReferral(testApp, token, id, { adminInfo: 'Original note' });
      const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
      const { parcels: rows } = await readPickList(testApp, token, pickListId);
      await markAttendance(testApp, token, rows[0]?.id ?? '', 'attended');

      const cancelled = await cancelReferral(testApp, token, id, { adminInfo: NOTE });
      expect(cancelled.status).toBe(409);

      const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(stored?.status).not.toBe('cancelled');
      expect(stored?.adminInfo).toBe('Original note');
    });

    it('refuses a rejected referral, and leaves the note alone', async () => {
      const { testApp, token, world: w } = await adminWorld();
      const { id } = await submitReferral(testApp, w, UNKNOWN_REFERRER, {
        clientIp: nextClientIp(),
      });
      // Set while the referral is still open to change — rejecting locks it.
      await patchReferral(testApp, token, id, { adminInfo: 'Original note' });
      const rejected = await testApp.request(`/api/v1/referrals/${id}/reject`, {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ comment: 'Not a referring organisation' }),
      });
      expect(rejected.status).toBe(200);

      const cancelled = await cancelReferral(testApp, token, id, { adminInfo: NOTE });
      expect(cancelled.status).toBe(409);

      const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(stored?.status).toBe('rejected');
      expect(stored?.adminInfo).toBe('Original note');
    });

    it('refuses a referral on a confirmed session, and leaves the note alone', async () => {
      const { testApp, token, world: w } = await adminWorld();
      const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
      await patchReferral(testApp, token, id, { adminInfo: 'Original note' });
      await confirmSessionDirectly(w.sessionId);

      const cancelled = await cancelReferral(testApp, token, id, { adminInfo: NOTE });
      expect(cancelled.status).toBe(409);

      const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(stored?.status).not.toBe('cancelled');
      expect(stored?.adminInfo).toBe('Original note');
    });
  });

  it('an idempotent repeat cancel does not overwrite the note from the first cancel', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const first = await cancelReferral(testApp, token, id, { adminInfo: 'First cancel note' });
    expect(first.status).toBe(200);

    const second = await cancelReferral(testApp, token, id, { adminInfo: 'Second cancel note' });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('cancelled');
    // The repeat is a no-op on an already-cancelled referral, so the new note
    // sent alongside it is never written.
    expect(second.body.adminInfo).toBe('First cancel note');

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adminInfo).toBe('First cancel note');
  });
});

describe('migration 0045 backfill', () => {
  /**
   * Only the `UPDATE` statement from the real migration — `ALTER TABLE` ran
   * once already via `test/setup.ts` and would error a second time. Reading
   * it out of `env.TEST_MIGRATIONS` rather than retyping the SQL is the
   * point: a test that restated the statement would prove nothing about the
   * one actually shipped.
   */
  function backfillStatements(): string[] {
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith('0045'));
    if (migration === undefined) {
      throw new Error('migration 0045 not found in TEST_MIGRATIONS — has it been renamed?');
    }
    return migration.queries.filter((query) => query.trim().toUpperCase().startsWith('UPDATE'));
  }

  async function runBackfill(): Promise<void> {
    for (const statement of backfillStatements()) {
      await env.DB.prepare(statement).run();
    }
  }

  it('sweeps every existing parcel note to NULL', async () => {
    const { testApp, token, world: w } = await pickingWorld();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId, undefined, [
      { referralId: referral.id, notes: 'No longer stocked: Beans' },
    ]);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    const parcelId = rows[0]?.id ?? '';

    const [before] = await db.select().from(parcels).where(eq(parcels.id, parcelId));
    expect(before?.notes).toBe('No longer stocked: Beans');

    await runBackfill();

    const [after] = await db.select().from(parcels).where(eq(parcels.id, parcelId));
    expect(after?.notes).toBeNull();
  });
});
