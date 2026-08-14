import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { createPickListsRepository } from '../src/modules/pick-lists/pick-lists.repository.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
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

/**
 * Puts stock on the shelves so movements can be seen against a real level.
 *
 * A stock take is now the only way stock arrives — there is no shop to record.
 */
async function stockUp(testApp: TestApp, token: string, w: PickingWorld): Promise<void> {
  await testApp.request('/api/v1/stock/take', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      counts: [
        { stockItemId: w.stockItems.Beans, countedQuantity: 100 },
        { stockItemId: w.stockItems.Pasta, countedQuantity: 100 },
        { stockItemId: w.stockItems.Cereal, countedQuantity: 100 },
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
  // Most attendance tests exercise the outcome/ledger rules, so make their
  // prerequisite explicit here. The separate test below covers refusing an
  // outcome before review.
  await testApp.request(`/api/v1/parcels/${parcelId}/review`, {
    method: 'POST',
    headers: authHeaders(token),
  });
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
  await db.delete(stockItems);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('recording attendance', () => {
  it('refuses attendance until the pick list has been reviewed', async () => {
    const { testApp, token, parcelId } = await oneParcel();
    const response = await testApp.request(`/api/v1/parcels/${parcelId}/attendance`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ attendance: 'attended' }),
    });
    expect(response.status).toBe(409);
  });

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
        actorUserId: null,
        occurredAt: now,
        createdAt: now,
      }),
    ).rejects.toThrow();
  });

  it('issues nothing when the household is cancelled between the read and the write', async () => {
    // The service checks `attendance === 'cancelled'` before it writes, but
    // that read is three round trips from the batch, and an admin cancelling
    // inside that window used to be overwritten back to `attended` — with the
    // stock gone. So this drives the two statements directly, exactly as
    // `record` composes them, against a parcel cancelled after the read: the
    // condition lives on the statements, not in the service, and this is what
    // proves it.
    const { testApp, token, parcelId, world: w } = await oneParcel();
    const repository = createPickListsRepository(db);
    const lines = await repository.listLinesFor(parcelId);
    expect(lines.length).toBeGreaterThan(0);

    // The cancellation lands first — as `buildCancelParcelsFor` would leave it.
    await db.update(parcels).set({ attendance: 'cancelled' }).where(eq(parcels.id, parcelId));

    const results = await db.$client.batch([
      repository.buildParcelIssue({
        parcelId,
        sessionId: w.sessionId,
        actorUserId: null,
        occurredAt: NOW,
        lines,
      }),
      repository.buildSetAttendance({
        parcelId,
        attendance: 'attended',
        actorUserId: null,
        at: NOW,
      }),
    ]);

    // Neither statement ran: the attendance stands at cancelled and not one
    // bean came off the shelf.
    expect(results[1]?.meta.changes).toBe(0);
    expect(
      await db.select().from(stockLedger).where(eq(stockLedger.movementType, 'parcel_issued')),
    ).toHaveLength(0);
    expect((await levels(testApp, token)).Beans).toBe(100);

    const [row] = await db.select().from(parcels).where(eq(parcels.id, parcelId));
    expect(row?.attendance).toBe('cancelled');
  });

  it('tells the caller when the household was cancelled mid-request', async () => {
    // The same race through the route, so the service reports it rather than
    // quietly succeeding on a write that did nothing.
    const { testApp, token, parcelId } = await oneParcel();
    await db.update(parcels).set({ attendance: 'cancelled' }).where(eq(parcels.id, parcelId));

    const response = await markAttendance(testApp, token, parcelId, 'attended');

    expect(response.status).toBe(409);
    expect(
      await db.select().from(stockLedger).where(eq(stockLedger.movementType, 'parcel_issued')),
    ).toHaveLength(0);
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

  it('never updates a ledger row', async () => {
    // Rows are written and, when an outcome is taken back, deleted. They are
    // never edited: the level is the sum of what is there, so an amended row
    // would be a figure with no movement behind it.
    const { testApp, token, parcelId } = await oneParcel();

    await markAttendance(testApp, token, parcelId, 'attended');
    const [issued] = await db.select().from(stockLedger).where(eq(stockLedger.parcelId, parcelId));

    await markAttendance(testApp, token, parcelId, 'no_show');
    await markAttendance(testApp, token, parcelId, 'attended');

    const [reissued] = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.parcelId, parcelId));
    // A fresh row, not the old one edited back into place.
    expect(reissued?.id).not.toBe(issued?.id);
    expect(reissued?.quantityDelta).toBe(issued?.quantityDelta);
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
  it('gives the stock back when an attendance is taken back', async () => {
    // The mis-tap fix. There is no hand correction any more, so the only way
    // to put one right is to say "no, they did not come after all" — and the
    // parcel's movements go with it, because nothing left the building.
    const { testApp, token, parcelId } = await oneParcel();

    await markAttendance(testApp, token, parcelId, 'attended');
    expect((await levels(testApp, token)).Beans).toBe(98);

    const takenBack = await markAttendance(testApp, token, parcelId, 'no_show');

    expect(takenBack.status).toBe(200);
    expect(takenBack.attendance).toBe('no_show');
    expect((await levels(testApp, token)).Beans).toBe(100);
    expect(
      await db.select().from(stockLedger).where(eq(stockLedger.parcelId, parcelId)),
    ).toHaveLength(0);
  });

  it('takes the stock again when a no-show turns out to have attended', async () => {
    const { testApp, token, parcelId } = await oneParcel();

    await markAttendance(testApp, token, parcelId, 'no_show');
    expect((await levels(testApp, token)).Beans).toBe(100);

    const corrected = await markAttendance(testApp, token, parcelId, 'attended');

    expect(corrected.status).toBe(200);
    expect(corrected.stockMoved).toBe(true);
    expect((await levels(testApp, token)).Beans).toBe(98);
  });

  it('leaves the stock right however many times the outcome is flipped', async () => {
    // A volunteer correcting themselves twice must not leave the shelf wrong.
    const { testApp, token, parcelId } = await oneParcel();

    for (const outcome of ['attended', 'no_show', 'attended', 'no_show', 'attended'] as const) {
      expect((await markAttendance(testApp, token, parcelId, outcome)).status).toBe(200);
    }

    expect((await levels(testApp, token)).Beans).toBe(98);
    expect(
      await db.select().from(stockLedger).where(eq(stockLedger.parcelId, parcelId)),
    ).toHaveLength(1);
  });

  it('taking back an outcome twice is harmless', async () => {
    const { testApp, token, parcelId } = await oneParcel();
    await markAttendance(testApp, token, parcelId, 'attended');

    const first = await markAttendance(testApp, token, parcelId, 'no_show');
    const second = await markAttendance(testApp, token, parcelId, 'no_show');

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.alreadyRecorded).toBe(true);
    expect((await levels(testApp, token)).Beans).toBe(100);
  });

  it('refuses to change an outcome once the session has been confirmed', async () => {
    // Confirming is the end of it: a session signed off must not have its
    // figures move underneath it afterwards.
    const { testApp, token, parcelId, world: w } = await oneParcel();
    await markAttendance(testApp, token, parcelId, 'attended');

    const confirmed = await testApp.request(`/api/v1/sessions/${w.sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(confirmed.status).toBe(200);

    const response = await testApp.request(`/api/v1/parcels/${parcelId}/attendance`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ attendance: 'no_show' }),
    });

    expect(response.status).toBe(409);
    expect((await levels(testApp, token)).Beans).toBe(98);
  });

  it('deletes only the movements of the parcel being taken back', async () => {
    const { testApp, token, world: w } = await world();
    await stockUp(testApp, token, w);
    await submitReferral(testApp, w, { adults: 1, children: 0 }, { clientIp: '203.0.113.1' });
    await submitReferral(testApp, w, { adults: 1, children: 0 }, { clientIp: '203.0.113.2' });

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const [first, second] = rows;

    await markAttendance(testApp, token, first?.id ?? '', 'attended');
    await markAttendance(testApp, token, second?.id ?? '', 'attended');
    expect((await levels(testApp, token)).Beans).toBe(96);

    await markAttendance(testApp, token, first?.id ?? '', 'no_show');

    expect((await levels(testApp, token)).Beans).toBe(98);
    expect(
      await db
        .select()
        .from(stockLedger)
        .where(eq(stockLedger.parcelId, second?.id ?? '')),
    ).toHaveLength(1);
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

  it('does not permit parcel edits after the session has been confirmed', async () => {
    const { testApp, token, world: w, parcelId } = await oneParcel();
    await markAttendance(testApp, token, parcelId, 'no_show');

    await testApp.request(`/api/v1/sessions/${w.sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const response = await testApp.request(`/api/v1/parcels/${parcelId}/lines`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ stockItemId: w.stockItems.Beans, quantity: 3 }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringMatching(/session has been confirmed/i) },
    });
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
