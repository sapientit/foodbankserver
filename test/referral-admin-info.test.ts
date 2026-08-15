import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createLogger } from '../src/core/log.ts';
import { MAX_ADMIN_INFO_LENGTH } from '../src/config/constants.ts';
import { createDatabase } from '../src/db/client.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { purgeReferralPii } from '../src/modules/jobs/purge-pii.ts';
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
 * `adminInfo` — the administrators' own free-text note about a household,
 * distinct from `answers` (what the referrer submitted) and `reviewComment`
 * (why a referral was accepted or rejected). Migration `0023`, and see
 * `src/modules/referrals/referrals.mapper.ts` for the access-control shape:
 * it is emitted only when a route asks for it **and** the caller is an
 * admin, and it is absent — not null — everywhere else.
 *
 * The file is organised around what the field must do (read/write, coexist
 * with `answers`, purge) and then around every surface it must stay off —
 * the list, the search, the printed sheets, the extract.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';
const NOTE = 'ADMIN NOTE: rang the office about the meter';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

let clientIpCounter = 0;
function nextClientIp(): string {
  clientIpCounter += 1;
  return `203.0.116.${String(clientIpCounter)}`;
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

  await testApp.request('/api/v1/stock/take', {
    method: 'POST',
    headers: json(accessToken),
    body: JSON.stringify({
      counts: [
        { stockItemId: world.stockItems.Beans, countedQuantity: 500 },
        { stockItemId: world.stockItems.Pasta, countedQuantity: 500 },
        { stockItemId: world.stockItems.Cereal, countedQuantity: 500 },
      ],
    }),
  });

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

describe('an admin can read, set, replace and clear the note', () => {
  it('sets it on PATCH and returns it, and GET carries it too', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const patched = await patchReferral(testApp, token, id, { adminInfo: NOTE });
    expect(patched.status).toBe(200);
    expect(patched.body.adminInfo).toBe(NOTE);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adminInfo).toBe(NOTE);

    const fetched = await getReferral(testApp, token, id);
    expect(fetched.status).toBe(200);
    expect(fetched.body.adminInfo).toBe(NOTE);
  });

  it('replaces it on a second PATCH', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    await patchReferral(testApp, token, id, { adminInfo: NOTE });
    const replaced = await patchReferral(testApp, token, id, {
      adminInfo: 'Follow-up: meter now on credit',
    });

    expect(replaced.status).toBe(200);
    expect(replaced.body.adminInfo).toBe('Follow-up: meter now on credit');

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adminInfo).toBe('Follow-up: meter now on credit');
  });

  it('clears it to null on an explicit null', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { adminInfo: NOTE });

    const cleared = await patchReferral(testApp, token, id, { adminInfo: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body.adminInfo).toBeNull();

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adminInfo).toBeNull();
  });

  it('leaves the stored note untouched when a PATCH omits the key entirely', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { adminInfo: NOTE });

    // Changes something else, omits adminInfo altogether.
    const patched = await patchReferral(testApp, token, id, { refereeSurname: 'Wintergreene' });
    expect(patched.status).toBe(200);
    expect(patched.body.adminInfo).toBe(NOTE);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.refereeSurname).toBe('Wintergreene');
    expect(stored?.adminInfo).toBe(NOTE);
  });
});

describe('every route that returns one referral carries the note', () => {
  // The four write routes return the same `Referral` shape as `GET
  // /referrals/{id}` and each had to opt in separately, so each is a place
  // the note could have been forgotten. A client that PATCHes and then
  // accepts would otherwise watch the field disappear from the response for
  // no reason it could see.
  it('accept, review and cancel all return it, and so does reject', async () => {
    const { testApp, token, world: w } = await adminWorld();

    const held = await submitReferral(testApp, w, UNKNOWN_REFERRER, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, held.id, { adminInfo: NOTE });

    const accepted = await testApp.request(`/api/v1/referrals/${held.id}/accept`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody: Record<string, unknown> = await accepted.json();
    expect(acceptedBody.adminInfo).toBe(NOTE);

    const reviewed = await testApp.request(`/api/v1/referrals/${held.id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(reviewed.status).toBe(200);
    const reviewedBody: Record<string, unknown> = await reviewed.json();
    expect(reviewedBody.adminInfo).toBe(NOTE);

    const cancelled = await testApp.request(`/api/v1/referrals/${held.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(cancelled.status).toBe(200);
    const cancelledBody: Record<string, unknown> = await cancelled.json();
    expect(cancelledBody.adminInfo).toBe(NOTE);

    // Rejecting needs its own referral: only a pending one can be rejected,
    // and the one above has been accepted.
    const turnedAway = await submitReferral(testApp, w, UNKNOWN_REFERRER, {
      clientIp: nextClientIp(),
    });
    await patchReferral(testApp, token, turnedAway.id, { adminInfo: NOTE });

    const rejected = await testApp.request(`/api/v1/referrals/${turnedAway.id}/reject`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(rejected.status).toBe(200);
    const rejectedBody: Record<string, unknown> = await rejected.json();
    expect(rejectedBody.adminInfo).toBe(NOTE);
  });

  it('withholds it from a team lead on those same routes by withholding the route', async () => {
    // The write routes are admin-only, so the team lead's boundary here is
    // the 403 rather than a narrowed body. Worth pinning: it is why the
    // mapper's role gate is the only thing standing between a team lead and
    // the note on `GET /referrals/{id}`, which they *can* reach.
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { adminInfo: NOTE });

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: leadToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const cancelled = await lead.request(`/api/v1/referrals/${id}/cancel`, {
      method: 'POST',
      headers: authHeaders(leadToken),
    });
    expect(cancelled.status).toBe(403);
  });
});

describe('answers and adminInfo do not disturb each other', () => {
  // The single most important test in the file: the client sends the whole
  // preserved answers map whenever an administrator saves one form page, and
  // that write must not carry the note off with it — and the reverse must
  // hold too, since the note is saved from a different screen entirely.
  it('a PATCH replacing answers leaves adminInfo exactly as it was', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(
      testApp,
      w,
      { answers: { Dietary: 'no pork' } },
      { clientIp: nextClientIp() },
    );
    await patchReferral(testApp, token, id, { adminInfo: NOTE });

    const patched = await patchReferral(testApp, token, id, {
      answers: { Dietary: 'vegetarian', Other: 'left in porch' },
    });
    expect(patched.status).toBe(200);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adminInfo).toBe(NOTE);
    const storedAnswers: Record<string, unknown> = JSON.parse(stored?.answersJson ?? '{}');
    expect(storedAnswers).toEqual({ Dietary: 'vegetarian', Other: 'left in porch' });
  });

  it('a PATCH setting only adminInfo leaves the stored answers exactly as they were', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(
      testApp,
      w,
      { answers: { Dietary: 'no pork', Secondary: 'benefit delay' } },
      { clientIp: nextClientIp() },
    );

    const patched = await patchReferral(testApp, token, id, { adminInfo: NOTE });
    expect(patched.status).toBe(200);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adminInfo).toBe(NOTE);
    const storedAnswers: Record<string, unknown> = JSON.parse(stored?.answersJson ?? '{}');
    expect(storedAnswers).toEqual({ Dietary: 'no pork', Secondary: 'benefit delay' });
  });
});

describe('the property is absent, not null, where a caller may not see it', () => {
  it('is absent from GET /referrals/{id} for a team lead, and the note text does not leak', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { adminInfo: NOTE });

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

    expect(text).not.toContain('adminInfo');
    expect(text).not.toContain(NOTE);

    // Positive control: the admin does get it, on the same referral.
    const asAdmin = await getReferral(testApp, token, id);
    expect(asAdmin.body.adminInfo).toBe(NOTE);
  });

  // The note cannot exist before a referral does, so this proves the
  // boundary the other way round: a public submitter cannot inject one
  // through a field the submission schema does not declare, and the receipt
  // — a separate mapper entirely — never carries the key regardless.
  it('is absent from the public referral receipt, and a spoofed value in the submission is not stored or echoed', async () => {
    const { testApp, world: w } = await adminWorld();

    const response = await testApp.request('/api/v1/public/referrals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission(w, { adminInfo: NOTE })),
    });
    expect(response.status).toBe(201);
    const text = await response.text();

    expect(text).not.toContain('adminInfo');
    expect(text).not.toContain(NOTE);

    const { id }: { id: string } = JSON.parse(text);
    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adminInfo).toBeNull();
  });
});

describe('absent from every list, export and print-oriented payload', () => {
  it('is absent from GET /referrals (the list), for an admin too — deliberate', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { adminInfo: NOTE });

    const response = await testApp.request('/api/v1/referrals', { headers: authHeaders(token) });
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(text).not.toContain('adminInfo');
    expect(text).not.toContain(NOTE);
    // Positive control: the referral really is on the list.
    expect(text).toContain(id);
  });

  // The one deliberate exception, settled 2026-08-15 (`INITIAL_SPEC1.txt`,
  // `#Searching for a referral`): the search route is admin-only outright, so
  // there is no thinner-row recipient to withhold the note from, and it rides
  // every result row. Full coverage of the shape (the null case, the role
  // boundary, the twelve-field row) lives in `test/referral-search.test.ts`;
  // this is the regression guard that sits next to every other "absent"
  // assertion in this describe block, so a change that put the note back
  // behind a role check here would be visible right where the rest of the
  // exceptions are.
  it('is present on POST /referrals/search — the one list of households that carries it', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU46 1AA' },
      { clientIp: nextClientIp() },
    );
    await patchReferral(testApp, token, id, { adminInfo: NOTE });

    const response = await testApp.request('/api/v1/referrals/search', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ postcode: 'GU46 1AA' }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(text).toContain('adminInfo');
    expect(text).toContain(NOTE);
    expect(text).toContain(id);
  });

  it('is absent from GET /referrals/{id}/repeat-referrals', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const shared = { refereePostcode: 'GU46 2BB' };
    const first = await submitReferral(testApp, w, shared, { clientIp: nextClientIp() });
    const second = await submitReferral(testApp, w, shared, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, first.id, { adminInfo: NOTE });
    await patchReferral(testApp, token, second.id, { adminInfo: 'A different note entirely' });

    const response = await testApp.request(`/api/v1/referrals/${second.id}/repeat-referrals`, {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(text).not.toContain('adminInfo');
    expect(text).not.toContain(NOTE);
    expect(text).not.toContain('A different note entirely');
    // Positive control: the match really is in there.
    expect(text).toContain(first.id);
  });

  it('is absent from GET /sessions/{id}/referral-details', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { adminInfo: NOTE });

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/referral-details`, {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(text).not.toContain('adminInfo');
    expect(text).not.toContain(NOTE);
    expect(text).toContain(id);
  });

  it('is absent from GET /sessions/{id}/listener-sheet', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { adminInfo: NOTE });

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/listener-sheet`, {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(text).not.toContain('adminInfo');
    expect(text).not.toContain(NOTE);
    expect(text).toContain(id);
  });

  it('is absent from the pick list — maintenance view and the printed sheet', async () => {
    const { testApp, token, world: w } = await pickingWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { adminInfo: NOTE });

    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);

    const maintenance = await testApp.request(`/api/v1/pick-lists/${pickListId}`, {
      headers: authHeaders(token),
    });
    expect(maintenance.status).toBe(200);
    const maintenanceText = await maintenance.text();
    expect(maintenanceText).not.toContain('adminInfo');
    expect(maintenanceText).not.toContain(NOTE);
    expect(maintenanceText).toContain(id);

    await reviewEveryParcel(testApp, token, pickListId);
    const printed = await testApp.request(`/api/v1/pick-lists/${pickListId}/print`, {
      headers: authHeaders(token),
    });
    expect(printed.status).toBe(200);
    const printedText = await printed.text();
    expect(printedText).not.toContain('adminInfo');
    expect(printedText).not.toContain(NOTE);
  });

  it('is absent from the fuel help list', async () => {
    const { testApp, token, world: w } = await pickingWorld();
    const created = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        sessionDate: '2026-08-18',
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Church Hall',
        capacity: 25,
      }),
    });
    const { id: sessionId }: { id: string } = await created.json();

    const { id: referralId } = await submitReferral(
      testApp,
      w,
      { sessionId, needsFuelHelp: true },
      { clientIp: nextClientIp() },
    );
    await patchReferral(testApp, token, referralId, { adminInfo: NOTE });

    const { id: pickListId } = await generatePickList(testApp, token, sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    for (const parcel of rows) {
      await testApp.request(`/api/v1/parcels/${parcel.id}/review`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      await testApp.request(`/api/v1/parcels/${parcel.id}/attendance`, {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ attendance: 'attended' }),
      });
    }
    await testApp.request(`/api/v1/sessions/${sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const response = await testApp.request('/api/v1/fuel-help-list', {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(text).not.toContain('adminInfo');
    expect(text).not.toContain(NOTE);
    expect(text).toContain(referralId);
  });

  it('is absent from the spreadsheet extract claim', async () => {
    const { world: w } = await adminWorld();
    const configured = buildTestApp({
      clock: fixedClock(NOW),
      bindings: {
        GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet-admin-info-test',
        GOOGLE_OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      },
      clientIp: 'test-extract-admin-info',
    });
    const { accessToken: extractToken } = await devLogin(configured, {
      email: 'admin@foodbank.org',
    });

    const { id } = await submitReferral(configured, w, {}, { clientIp: nextClientIp() });
    await patchReferral(configured, extractToken, id, { adminInfo: NOTE });

    await db
      .update(sessions)
      .set({ status: 'confirmed', confirmedAt: NOW, updatedAt: NOW })
      .where(eq(sessions.id, w.sessionId));

    const response = await configured.request('/api/v1/extracts/claims', {
      method: 'POST',
      headers: authHeaders(extractToken),
    });
    expect(response.status).toBe(200);
    const text = await response.text();

    expect(text).not.toContain('adminInfo');
    expect(text).not.toContain(NOTE);
    expect(text).toContain(id);
  });

  // Not covered: an SMS payload. `composeReminder` and every route under
  // `src/modules/sms` build a message from the session (date, time, place)
  // and never read `referrals.adminInfo` at all — there is no code path that
  // could reach it, so there is nothing for a raw-text assertion to catch
  // that a read of `src/modules/sms/*.ts` does not already show. See the
  // report for the grep that established this.
});

describe('the purge clears adminInfo alongside the household, and leaves reviewComment', () => {
  it('nulls adminInfo on an old referral while keeping reviewComment intact', async () => {
    const { testApp, token, world: w } = await adminWorld();
    // Held for review, so accepting attaches a reviewComment to contrast with.
    const submitted = await submitReferral(testApp, w, UNKNOWN_REFERRER, {
      clientIp: nextClientIp(),
    });
    expect(submitted.referralStatus).toBe('pending_review');

    await testApp.request(`/api/v1/referrals/${submitted.id}/accept`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ comment: 'Approved by phone, referrer checked out' }),
    });
    await patchReferral(testApp, token, submitted.id, { adminInfo: NOTE });

    await db
      .update(referrals)
      .set({ referredAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(referrals.id, submitted.id));

    const result = await purgeReferralPii({
      db,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
      retentionDays: 365,
    });
    expect(result.purged).toBe(1);

    const [row] = await db.select().from(referrals).where(eq(referrals.id, submitted.id));
    expect(row?.adminInfo).toBeNull();
    // The contrast, in the same test: reviewComment records a decision the
    // charity made and is not aimed at by the purge, unlike the note.
    expect(row?.reviewComment).toBe('Approved by phone, referrer checked out');
    // And the household fields it goes alongside.
    expect(row?.refereeSurname).toBeNull();
  });
});

describe('validation', () => {
  it('refuses an empty string with 400', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const response = await patchReferral(testApp, token, id, { adminInfo: '' });
    expect(response.status).toBe(400);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adminInfo).toBeNull();
  });

  it('refuses whitespace-only text with 400, since it is trimmed first', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const response = await patchReferral(testApp, token, id, { adminInfo: '   ' });
    expect(response.status).toBe(400);
  });

  it('accepts exactly 2000 characters and refuses 2001, and stores it trimmed', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    expect(MAX_ADMIN_INFO_LENGTH).toBe(2000);

    const atLimit = await patchReferral(testApp, token, id, {
      adminInfo: `  ${'a'.repeat(MAX_ADMIN_INFO_LENGTH)}  `,
    });
    expect(atLimit.status).toBe(200);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    // Trimmed on the way in: the padding above must not have been counted
    // against the limit, and must not have been stored.
    expect(stored?.adminInfo).toBe('a'.repeat(MAX_ADMIN_INFO_LENGTH));
    expect(stored?.adminInfo?.length).toBe(MAX_ADMIN_INFO_LENGTH);

    const overLimit = await patchReferral(testApp, token, id, {
      adminInfo: 'a'.repeat(MAX_ADMIN_INFO_LENGTH + 1),
    });
    expect(overLimit.status).toBe(400);

    // Unchanged by the refused request.
    const [afterRefusal] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(afterRefusal?.adminInfo?.length).toBe(MAX_ADMIN_INFO_LENGTH);
  });
});

describe('PATCH still refuses the referrer identity fields, adminInfo alongside them or not', () => {
  it('refuses referrerEmail, referrerName, referrerPhone and referrerOrganisation, each named with 400', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    for (const body of [
      { referrerEmail: 'someone@else.example' },
      { referrerName: 'Someone Else' },
      { referrerPhone: '01483 999999' },
      { referrerOrganisation: 'A Different Council' },
    ]) {
      const response = await patchReferral(testApp, token, id, body);
      expect(response.status, `PATCH ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it('refuses adminInfo sent together with referrerEmail, and writes neither', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const response = await patchReferral(testApp, token, id, {
      adminInfo: NOTE,
      referrerEmail: 'someone@else.example',
    });
    expect(response.status).toBe(400);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adminInfo).toBeNull();
    expect(stored?.referrerEmail).toBe('jane@guildford.gov.uk');
  });
});

describe('role access', () => {
  it('refuses a team lead PATCHing adminInfo with 403, and leaves the note unchanged', async () => {
    const { testApp, token, world: w } = await adminWorld();
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });
    await patchReferral(testApp, token, id, { adminInfo: NOTE });

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: leadToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });
    const response = await lead.request(`/api/v1/referrals/${id}`, {
      method: 'PATCH',
      headers: json(leadToken),
      body: JSON.stringify({ adminInfo: 'A team lead should not be able to write this' }),
    });
    expect(response.status).toBe(403);

    const [stored] = await db.select().from(referrals).where(eq(referrals.id, id));
    expect(stored?.adminInfo).toBe(NOTE);
  });
});
