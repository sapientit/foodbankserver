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
import {
  purchaseLines,
  purchases,
  stockItems,
  stockLedger,
  stockTakeLines,
  stockTakes,
} from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  generatePickList,
  readPickList,
  setUpPickingWorld,
  submitReferral,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

async function world(): Promise<{ testApp: TestApp; token: string; world: PickingWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'lead@foodbank.org' });
  const built = await setUpPickingWorld(testApp, accessToken);
  return { testApp, token: accessToken, world: built };
}

/** Puts stock on the shelves so movements can be seen against a real level. */
async function stockUp(testApp: TestApp, token: string, w: PickingWorld): Promise<void> {
  await testApp.request('/api/v1/stock/purchases', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      lines: [
        { stockItemId: w.stockItems.Beans, quantity: 100 },
        { stockItemId: w.stockItems.Pasta, quantity: 100 },
        { stockItemId: w.stockItems.Cereal, quantity: 100 },
      ],
    }),
  });
}

async function levels(testApp: TestApp, token: string): Promise<Record<string, number>> {
  const response = await testApp.request('/api/v1/stock/levels', { headers: authHeaders(token) });
  const body: { items: { name: string; quantityOnHand: number }[] } = await response.json();
  return Object.fromEntries(body.items.map((item) => [item.name, item.quantityOnHand]));
}

async function markAttendance(
  testApp: TestApp,
  token: string,
  parcelId: string,
  attendance: 'attended' | 'no_show',
) {
  const response = await testApp.request(`/api/v1/parcels/${parcelId}/attendance`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ attendance }),
  });
  const body: { attendance?: string; stockMoved?: boolean; alreadyRecorded?: boolean } =
    await response.json();
  return { status: response.status, ...body };
}

/** A session with one household of 1 adult: 2 tins of Beans. */
async function oneParcel() {
  const built = await world();
  await stockUp(built.testApp, built.token, built.world);
  await submitReferral(built.testApp, built.world, { adults: 1, children: 0 });

  const { id } = await generatePickList(built.testApp, built.token, built.world.sessionId);
  const { parcels: rows } = await readPickList(built.testApp, built.token, id);

  return { ...built, pickListId: id, parcelId: rows[0]?.id ?? '' };
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
  // Purchases and stock takes reference stock items, so they go first or the
  // foreign key blocks the delete and leaves the next test on dirty state.
  await db.delete(purchaseLines);
  await db.delete(purchases);
  await db.delete(stockTakeLines);
  await db.delete(stockTakes);
  await db.delete(stockItems);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('recording attendance', () => {
  it('decrements stock when a household attends', async () => {
    const { testApp, token, parcelId } = await oneParcel();

    expect((await levels(testApp, token)).Beans).toBe(100);

    const result = await markAttendance(testApp, token, parcelId, 'attended');
    expect(result.status).toBe(200);
    expect(result.stockMoved).toBe(true);

    expect((await levels(testApp, token)).Beans).toBe(98);
  });

  it('records stock movements exactly once when attendance is submitted twice', async () => {
    // A team lead will double-tap, and a slow request will be retried. This is
    // the failure nobody notices until a stock take will not reconcile.
    const { testApp, token, parcelId } = await oneParcel();

    const first = await markAttendance(testApp, token, parcelId, 'attended');
    const second = await markAttendance(testApp, token, parcelId, 'attended');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.alreadyRecorded).toBe(true);

    // The count that matters: one ledger row per line, not two.
    const issued = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.movementType, 'parcel_issued'));
    expect(issued).toHaveLength(1);
    expect((await levels(testApp, token)).Beans).toBe(98);
  });

  it('moves stock once when two requests arrive at the same moment', async () => {
    // The sequential double-tap above is also caught by an early "already in
    // this state" check. **This** test is what proves the unique index: both
    // requests read `pending` before either writes, so the early check passes
    // for both and only the guard prevents issuing the parcel twice.
    const { testApp, token, parcelId } = await oneParcel();

    const [first, second] = await Promise.all([
      markAttendance(testApp, token, parcelId, 'attended'),
      markAttendance(testApp, token, parcelId, 'attended'),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);

    const issued = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.movementType, 'parcel_issued'));
    expect(issued).toHaveLength(1);
    expect((await levels(testApp, token)).Beans).toBe(98);
  });

  it('refuses a duplicate ledger entry for the same parcel and movement', async () => {
    // The guard itself, at the database level — independent of any service
    // logic that might later be refactored away.
    const { testApp, token, parcelId, world: w } = await oneParcel();
    await markAttendance(testApp, token, parcelId, 'attended');

    const [existing] = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.movementType, 'parcel_issued'));
    const now = new Date().toISOString();

    await expect(
      db.insert(stockLedger).values({
        id: crypto.randomUUID(),
        stockItemId: existing?.stockItemId ?? w.stockItems.Beans,
        quantityDelta: -2,
        movementType: 'parcel_issued',
        parcelId,
        sessionId: w.sessionId,
        purchaseId: null,
        stockTakeId: null,
        reason: null,
        actorUserId: null,
        occurredAt: now,
        createdAt: now,
      }),
    ).rejects.toThrow();
  });

  it('survives being submitted five times', async () => {
    const { testApp, token, parcelId } = await oneParcel();

    for (let i = 0; i < 5; i++) {
      expect((await markAttendance(testApp, token, parcelId, 'attended')).status).toBe(200);
    }

    expect((await levels(testApp, token)).Beans).toBe(98);
  });

  it('records no stock movement for a no-show', async () => {
    // Nothing was given away, so there is nothing to return. The parcel is
    // simply unpacked.
    const { testApp, token, parcelId } = await oneParcel();

    const result = await markAttendance(testApp, token, parcelId, 'no_show');

    expect(result.status).toBe(200);
    expect(result.stockMoved).toBe(false);
    expect(
      await db.select().from(stockLedger).where(eq(stockLedger.movementType, 'parcel_issued')),
    ).toHaveLength(0);
    expect((await levels(testApp, token)).Beans).toBe(100);
  });

  it('links the movement to the parcel and session for auditing', async () => {
    const { testApp, token, parcelId, world: w } = await oneParcel();
    await markAttendance(testApp, token, parcelId, 'attended');

    const [entry] = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.movementType, 'parcel_issued'));

    expect(entry?.parcelId).toBe(parcelId);
    expect(entry?.sessionId).toBe(w.sessionId);
    expect(entry?.quantityDelta).toBe(-2);
    expect(entry?.actorUserId).toEqual(expect.any(String));
  });

  it('moves every line of a multi-item parcel', async () => {
    const { testApp, token, world: w } = await world();
    await stockUp(testApp, token, w);
    await submitReferral(testApp, w, { adults: 2, children: 3 });

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);

    await markAttendance(testApp, token, rows[0]?.id ?? '', 'attended');

    // Family parcel: 4 Beans, 2 Pasta, 1 Cereal.
    expect(await levels(testApp, token)).toEqual({ Beans: 96, Pasta: 98, Cereal: 99 });
  });

  it('never updates or deletes a ledger row', async () => {
    const { testApp, token, parcelId } = await oneParcel();

    await markAttendance(testApp, token, parcelId, 'attended');
    const before = await db.select().from(stockLedger);

    // The outcome is final, so the refused contradiction must leave the
    // append-only ledger exactly as it was.
    expect((await markAttendance(testApp, token, parcelId, 'no_show')).status).toBe(409);

    expect(await db.select().from(stockLedger)).toEqual(before);
  });

  it('records the outcome without reissuing when the parcel is already in the ledger', async () => {
    // The ledger row landed without its attendance update — the one state the
    // guard has to repair rather than refuse, since otherwise no request could
    // ever record this parcel.
    const { testApp, token, parcelId, world: w } = await oneParcel();
    const now = new Date().toISOString();

    await db.insert(stockLedger).values({
      id: crypto.randomUUID(),
      stockItemId: w.stockItems.Beans,
      quantityDelta: -2,
      movementType: 'parcel_issued',
      parcelId,
      sessionId: w.sessionId,
      purchaseId: null,
      stockTakeId: null,
      reason: null,
      actorUserId: null,
      occurredAt: now,
      createdAt: now,
    });

    const result = await markAttendance(testApp, token, parcelId, 'attended');

    expect(result.status).toBe(200);
    expect(result.attendance).toBe('attended');
    expect(result.stockMoved).toBe(false);
    expect(
      await db.select().from(stockLedger).where(eq(stockLedger.movementType, 'parcel_issued')),
    ).toHaveLength(1);
    expect((await levels(testApp, token)).Beans).toBe(98);
  });
});

describe('a recorded outcome is final', () => {
  it('refuses a no-show once the household has been recorded as attending', async () => {
    const { testApp, token, parcelId } = await oneParcel();

    await markAttendance(testApp, token, parcelId, 'attended');
    const contradiction = await markAttendance(testApp, token, parcelId, 'no_show');

    expect(contradiction.status).toBe(409);
    // The parcel keeps the outcome it was given, and so does the stock.
    expect((await levels(testApp, token)).Beans).toBe(98);
  });

  it('refuses attendance once the household has been recorded as a no-show', async () => {
    const { testApp, token, parcelId } = await oneParcel();

    await markAttendance(testApp, token, parcelId, 'no_show');
    const contradiction = await markAttendance(testApp, token, parcelId, 'attended');

    expect(contradiction.status).toBe(409);
    expect(
      await db.select().from(stockLedger).where(eq(stockLedger.movementType, 'parcel_issued')),
    ).toHaveLength(0);
    expect((await levels(testApp, token)).Beans).toBe(100);
  });

  it('points the team lead at correcting the stock instead', async () => {
    const { testApp, token, parcelId } = await oneParcel();
    await markAttendance(testApp, token, parcelId, 'attended');

    const response = await testApp.request(`/api/v1/parcels/${parcelId}/attendance`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ attendance: 'no_show' }),
    });
    const body: { error: { code: string; message: string } } = await response.json();

    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toMatch(/correct the stock/i);
  });

  it('never writes a second movement against a parcel', async () => {
    // Nothing may undo an issue. The reversal path is gone and so is the
    // `parcel_returned` movement type it used to write — 0011 took it out of
    // the CHECK constraint, so a reversal could not be recorded even by hand.
    const { testApp, token, parcelId } = await oneParcel();

    await markAttendance(testApp, token, parcelId, 'attended');
    await markAttendance(testApp, token, parcelId, 'no_show');

    const entries = await db.select().from(stockLedger);
    expect(
      entries.filter((row) => row.parcelId === parcelId).map((row) => row.movementType),
    ).toEqual(['parcel_issued']);
  });
});

describe('confirming the session', () => {
  it('cannot be closed while anyone is unmarked', async () => {
    const { testApp, token, world: w } = await world();
    await stockUp(testApp, token, w);
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    await submitReferral(testApp, w, { adults: 2, children: 3 });

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    await markAttendance(testApp, token, rows[0]?.id ?? '', 'attended');

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(409);
    const body: { error: { details: { pendingPickNumbers: number[] } } } = await response.json();
    expect(body.error.details.pendingPickNumbers).toEqual([2]);
  });

  it('confirms once everyone has been ticked off', async () => {
    const { testApp, token, world: w, parcelId } = await oneParcel();
    await markAttendance(testApp, token, parcelId, 'attended');

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(200);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, w.sessionId));
    expect(session?.status).toBe('confirmed');
    expect(session?.confirmedByUserId).toEqual(expect.any(String));
  });

  it('confirming twice is harmless', async () => {
    const { testApp, token, world: w, parcelId } = await oneParcel();
    await markAttendance(testApp, token, parcelId, 'no_show');

    for (let i = 0; i < 2; i++) {
      const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/confirm`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      expect(response.status).toBe(200);
    }
  });

  it('is open to a team lead, who is the one in the hall', async () => {
    const { testApp, token, world: w, parcelId } = await oneParcel();

    // The fixture already logs in as a team lead; assert that explicitly.
    const me = await testApp.request('/api/v1/auth/me', { headers: authHeaders(token) });
    expect(await me.json()).toMatchObject({ role: 'admin' });

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'realteamlead@foodbank.org',
      role: 'team_lead',
    });

    expect((await markAttendance(lead, accessToken, parcelId, 'attended')).status).toBe(200);
    const confirmed = await lead.request(`/api/v1/sessions/${w.sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });
    expect(confirmed.status).toBe(200);
  });
});

describe('the whole session, end to end', () => {
  it('leaves stock reflecting exactly who turned up', async () => {
    const { testApp, token, world: w } = await world();
    await stockUp(testApp, token, w);

    // Three households: two attend, one does not.
    await submitReferral(testApp, w, { adults: 1, children: 0 }); // 2 Beans
    await submitReferral(testApp, w, { adults: 2, children: 3 }); // 4 Beans, 2 Pasta, 1 Cereal
    await submitReferral(testApp, w, { adults: 1, children: 1 }); // 2 Beans

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);

    await markAttendance(testApp, token, rows[0]?.id ?? '', 'attended');
    await markAttendance(testApp, token, rows[1]?.id ?? '', 'attended');
    await markAttendance(testApp, token, rows[2]?.id ?? '', 'no_show');

    const confirmed = await testApp.request(`/api/v1/sessions/${w.sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(confirmed.status).toBe(200);

    // 2 + 4 Beans issued, the no-show's 2 stay on the shelf.
    expect(await levels(testApp, token)).toEqual({ Beans: 94, Pasta: 98, Cereal: 99 });
  });
});
