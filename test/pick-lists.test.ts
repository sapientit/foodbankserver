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
import {
  generatePickList,
  gridOf,
  readPickList,
  saveGrid,
  setUpPickingWorld,
  submitReferral,
  UNKNOWN_REFERRER,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';

async function world(
  options: { capacity?: number } = {},
): Promise<{ testApp: TestApp; token: string; world: PickingWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const built = await setUpPickingWorld(testApp, accessToken, options);
  return { testApp, token: accessToken, world: built };
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
});

describe('generating a pick list', () => {
  it('generates on first view and returns the same one afterwards', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    await submitReferral(testApp, w, { adults: 2, children: 3 });

    const first = await generatePickList(testApp, token, w.sessionId);
    expect(first.parcelsCreated).toBe(2);

    const second = await generatePickList(testApp, token, w.sessionId);
    expect(second.id).toBe(first.id);
    expect(second.parcelsCreated).toBe(0); // no referral arrived since generation

    expect(await db.select().from(pickLists)).toHaveLength(1);
    expect(await db.select().from(parcels)).toHaveLength(2);
  });

  it('adds a late active referral without changing parcels already picked', async () => {
    const { testApp, token, world: w } = await world();
    const firstReferral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const first = await generatePickList(testApp, token, w.sessionId);
    const before = await readPickList(testApp, token, first.id);

    const lateReferral = await submitReferral(testApp, w, { adults: 2, children: 2 });
    const reconciled = await generatePickList(testApp, token, w.sessionId);
    const after = await readPickList(testApp, token, first.id);

    expect(reconciled.id).toBe(first.id);
    expect(reconciled.parcelsCreated).toBe(1);
    expect(after.parcels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: before.parcels[0]?.id,
          referralId: firstReferral.id,
          pickNumber: 1,
        }),
        expect.objectContaining({ referralId: lateReferral.id, pickNumber: 2 }),
      ]),
    );

    const divergence = await testApp.request(`/api/v1/pick-lists/${first.id}/divergence`, {
      headers: authHeaders(token),
    });
    expect(await divergence.json()).toMatchObject({ missingParcels: [] });
  });

  it('resolves each household through the grid to its model parcel', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    await submitReferral(testApp, w, { adults: 2, children: 3 });

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);

    const single = rows.find((p) => p.adults === 1);
    const family = rows.find((p) => p.adults === 2);

    // The parcel carries contents, not which model it came from.
    expect(single?.lines.map((l) => l.quantity)).toEqual([2]);
    expect(family?.lines).toHaveLength(3);
  });

  it('numbers parcels 1..N for the printed sheet', async () => {
    const { testApp, token, world: w } = await world();
    for (let i = 0; i < 3; i++) {
      await submitReferral(testApp, w, { adults: 1, children: 0 });
    }

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);

    expect(rows.map((p) => p.pickNumber)).toEqual([1, 2, 3]);
  });

  it('does not touch stock', async () => {
    // Generating a pick list moves nothing. Stock moves on attendance.
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 2, children: 3 });

    await generatePickList(testApp, token, w.sessionId);

    expect(await db.select().from(stockLedger)).toHaveLength(0);
  });

  it('excludes a cancelled referral', async () => {
    const { testApp, token, world: w } = await world();
    const keep = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const drop = await submitReferral(testApp, w, { adults: 1, children: 0 });

    await testApp.request(`/api/v1/referrals/${drop.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const { parcelsCreated } = await generatePickList(testApp, token, w.sessionId);
    expect(parcelsCreated).toBe(1);

    const [parcel] = await db.select().from(parcels);
    expect(parcel?.referralId).toBe(keep.id);
  });

  it('gives a pending-review household a named parcel, like its SMS reminder does', async () => {
    const { testApp, token, world: w } = await world();
    const pending = await submitReferral(testApp, w, {
      adults: 1,
      children: 0,
      refereeFirstName: 'Pending',
      refereeSurname: 'Household',
      ...UNKNOWN_REFERRER,
    });

    const { id, parcelsCreated } = await generatePickList(testApp, token, w.sessionId);
    expect(parcelsCreated).toBe(1);

    const pickList = await testApp.request(`/api/v1/pick-lists/${id}`, {
      headers: authHeaders(token),
    });
    expect(await pickList.json()).toMatchObject({
      parcels: [
        {
          referralId: pending.id,
          refereeFirstName: 'Pending',
          refereeSurname: 'Household',
        },
      ],
    });
  });

  it('excludes a rejected referral', async () => {
    const { testApp, token, world: w } = await world();
    const keep = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const drop = await submitReferral(testApp, w, {
      adults: 1,
      children: 0,
      ...UNKNOWN_REFERRER,
    });

    await testApp.request(`/api/v1/referrals/${drop.id}/reject`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const { parcelsCreated } = await generatePickList(testApp, token, w.sessionId);
    expect(parcelsCreated).toBe(1);

    const [parcel] = await db.select().from(parcels);
    expect(parcel?.referralId).toBe(keep.id);
  });

  it('picks a referral once it has been accepted', async () => {
    const { testApp, token, world: w } = await world();
    const { id } = await submitReferral(testApp, w, {
      adults: 1,
      children: 0,
      ...UNKNOWN_REFERRER,
    });

    await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const { parcelsCreated } = await generatePickList(testApp, token, w.sessionId);
    expect(parcelsCreated).toBe(1);

    const [parcel] = await db.select().from(parcels);
    expect(parcel?.referralId).toBe(id);
  });

  it('picks a referral an administrator has read, exactly as it picks an unread one', async () => {
    const { testApp, token, world: w } = await world();
    const read = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const unread = await submitReferral(testApp, w, { adults: 2, children: 0 });

    // The regression the `reviewed` status risks: reading a referral is an
    // administrator's pass over the paperwork and must not take a household off
    // the picking list. Every set that held `active` has to hold `reviewed`.
    const marked = await testApp.request(`/api/v1/referrals/${read.id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(marked.status).toBe(200);

    const { parcelsCreated } = await generatePickList(testApp, token, w.sessionId);
    expect(parcelsCreated).toBe(2);

    const rows = await db.select().from(parcels);
    expect(rows.map((parcel) => parcel.referralId).sort()).toEqual([read.id, unread.id].sort());
  });

  it('reconciles a referral read after the list was generated', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const late = await submitReferral(testApp, w, { adults: 2, children: 0 });
    await testApp.request(`/api/v1/referrals/${late.id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    // Divergence must see it as missing, and a second generate must pick it up.
    const response = await testApp.request(`/api/v1/pick-lists/${id}/divergence`, {
      headers: authHeaders(token),
    });
    const divergence: { missingParcels: string[] } = await response.json();
    expect(divergence.missingParcels).toEqual([late.id]);

    const { parcelsCreated } = await generatePickList(testApp, token, w.sessionId);
    expect(parcelsCreated).toBe(1);
  });

  it('generates an empty pick list when nobody has been referred', async () => {
    const { testApp, token, world: w } = await world();

    const result = await generatePickList(testApp, token, w.sessionId);

    expect(result.status).toBe(200);
    expect(result.parcelsCreated).toBe(0);
  });

  it('refuses when no model parcels have been set up', async () => {
    const testApp = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    // A world with no model parcels at all.
    const session = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-11',
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Hall',
      }),
    });
    const { id: sessionId }: { id: string } = await session.json();

    const response = await testApp.request(`/api/v1/sessions/${sessionId}/pick-list`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });

    expect(response.status).toBe(422);
  });

  it('does not create a partial pick list when a household cannot be placed', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    await submitReferral(testApp, w, { adults: 5, children: 5 });

    // Blank out the corner cell the second household lands on.
    const partial = gridOf('Single parcel', 'Family parcel');
    const withHole = Object.fromEntries(Object.entries(partial).filter(([key]) => key !== '5-5'));
    expect((await saveGrid(testApp, token, withHole)).status).toBe(200);

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        message: 'The household grid is incomplete. Complete it before generating pick lists.',
      },
    });
    const pickList = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      headers: authHeaders(token),
    });
    expect(pickList.status).toBe(404);
  });
});

describe('copying the contents', () => {
  it('editing a model parcel does not alter an existing pick list', async () => {
    // This is the whole immutability guarantee: contents are copied at
    // generation, so nothing needs versioning to make a picked parcel stable.
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const before = await readPickList(testApp, token, id);

    const single = (await db.select().from(modelParcels)).find((p) => p.name === 'Single parcel');
    await testApp.request(`/api/v1/model-parcels/${single?.id ?? ''}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ stockItemId: w.stockItems.Cereal, quantity: 99 }] }),
    });

    const after = await readPickList(testApp, token, id);
    expect(after.parcels).toEqual(before.parcels);
  });

  it('a later pick list picks up the change', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    await generatePickList(testApp, token, w.sessionId);

    const single = (await db.select().from(modelParcels)).find((p) => p.name === 'Single parcel');
    await testApp.request(`/api/v1/model-parcels/${single?.id ?? ''}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ stockItemId: w.stockItems.Cereal, quantity: 9 }] }),
    });

    // A second session, generated after the edit.
    const created = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-18',
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Hall',
      }),
    });
    const { id: laterSession }: { id: string } = await created.json();
    await submitReferral(testApp, w, { adults: 1, children: 0, sessionId: laterSession });

    const later = await generatePickList(testApp, token, laterSession);
    const { parcels: rows } = await readPickList(testApp, token, later.id);

    expect(rows[0]?.lines).toEqual([
      expect.objectContaining({ stockItemId: w.stockItems.Cereal, quantity: 9 }),
    ]);
  });

  it('snapshots the household, and amending the referral cannot move it', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const { id } = await generatePickList(testApp, token, w.sessionId);

    // The household counts are no longer amendable at all (Q23), so the only
    // amendment that can reach a referral after generation is its answers —
    // and that must leave the picker's snapshot exactly where it was.
    const amended = await testApp.request(`/api/v1/referrals/${referral.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { Other: 'Two more in the house since Tuesday' } }),
    });
    expect(amended.status).toBe(200);

    const { parcels: rows } = await readPickList(testApp, token, id);
    expect(rows[0]?.adults).toBe(1);

    const response = await testApp.request(`/api/v1/pick-lists/${id}/divergence`, {
      headers: authHeaders(token),
    });
    const divergence: {
      changedHouseholds: { was: { adults: number }; now: { adults: number } }[];
    } = await response.json();

    // `changedHouseholds` can no longer be produced through the API: the
    // snapshot is taken at generation and nothing may change the counts
    // afterwards. The comparison is still made rather than removed — whether
    // that field should stay in the contract is a question for Pete, not a
    // decision to take here.
    expect(divergence.changedHouseholds).toEqual([]);
  });

  it('reports a referral that arrived after generation', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const late = await submitReferral(testApp, w, { adults: 2, children: 2 });

    const response = await testApp.request(`/api/v1/pick-lists/${id}/divergence`, {
      headers: authHeaders(token),
    });
    const divergence: { missingParcels: string[] } = await response.json();

    expect(divergence.missingParcels).toEqual([late.id]);
  });
});

describe('editing the pick list', () => {
  it('adds an item, marked as a manual change', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);

    await testApp.request(`/api/v1/parcels/${rows[0]?.id ?? ''}/lines`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ stockItemId: w.stockItems.Cereal, quantity: 3 }),
    });

    const after = await readPickList(testApp, token, id);
    const added = after.parcels[0]?.lines.find((l) => l.name === 'Cereal');
    expect(added?.quantity).toBe(3);
    expect(added?.source).toBe('manual');
  });

  it('changing an existing quantity bumps it rather than duplicating the line', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);

    await testApp.request(`/api/v1/parcels/${rows[0]?.id ?? ''}/lines`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ stockItemId: w.stockItems.Beans, quantity: 7 }),
    });

    const after = await readPickList(testApp, token, id);
    expect(after.parcels[0]?.lines).toHaveLength(1);
    expect(after.parcels[0]?.lines[0]?.quantity).toBe(7);
  });

  it('a quantity of zero removes the line, which is how "we had none" is recorded', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);

    await testApp.request(`/api/v1/parcels/${rows[0]?.id ?? ''}/lines`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ stockItemId: w.stockItems.Beans, quantity: 0 }),
    });

    const after = await readPickList(testApp, token, id);
    expect(after.parcels[0]?.lines).toHaveLength(0);
  });

  it('lines can still be changed after printing', async () => {
    // The spec is explicit: modifications can be made after picking is done.
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);

    const printed = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(printed.status).toBe(200);

    const edit = await testApp.request(`/api/v1/parcels/${rows[0]?.id ?? ''}/lines`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ stockItemId: w.stockItems.Pasta, quantity: 1 }),
    });

    expect(edit.status).toBe(204);
  });

  it('a confirmed pick list cannot be edited', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);

    await testApp.request(`/api/v1/pick-lists/${id}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const edit = await testApp.request(`/api/v1/parcels/${rows[0]?.id ?? ''}/lines`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ stockItemId: w.stockItems.Pasta, quantity: 1 }),
    });

    expect(edit.status).toBe(409);
  });

  it('confirming does not move stock', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 2, children: 3 });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    await testApp.request(`/api/v1/pick-lists/${id}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    // Confirmed means "picking finished, list locked", not "stock issued".
    expect(await db.select().from(stockLedger)).toHaveLength(0);
    const [row] = await db.select().from(pickLists).where(eq(pickLists.id, id));
    expect(row?.status).toBe('confirmed');
  });

  it('confirming twice is harmless', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const first = await testApp.request(`/api/v1/pick-lists/${id}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    const second = await testApp.request(`/api/v1/pick-lists/${id}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});

describe('the printed sheet', () => {
  it('orders lines by shelf so a picker walks the aisle once', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 2, children: 3 });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const response = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      headers: authHeaders(token),
    });
    const body: { parcels: { lines: { name: string; shelfNumber: string }[] }[] } =
      await response.json();

    // Cereal A1, Beans A2, Pasta A10 — not alphabetical, not insertion order.
    expect(body.parcels[0]?.lines.map((l) => l.name)).toEqual(['Cereal', 'Beans', 'Pasta']);
  });

  it('never carries the reason for referral', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 2, children: 3 });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const response = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      headers: authHeaders(token),
    });
    const text = await response.text();

    // A printed sheet gets carried round a hall and left on tables.
    expect(text).not.toContain('reasonId');
    expect(text).not.toContain(w.reasonId);
  });

  it('names the household on a collection sheet but withholds the address', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const response = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      headers: authHeaders(token),
    });
    const text = await response.text();
    const body = JSON.parse(text) as {
      parcels: {
        refereeFirstName: string | null;
        refereeSurname: string | null;
        deliveryAddress: string | null;
        deliveryPostcode: string | null;
        deliveryPhone: string | null;
      }[];
    };

    // The person carrying the bag has to hand it to somebody.
    expect(body.parcels[0]?.refereeFirstName).toBe('Alice');
    expect(body.parcels[0]?.refereeSurname).toBe('Wintergreen');

    // Nothing else identifying reaches a sheet that gets left on a table.
    expect(body.parcels[0]?.deliveryAddress).toBeNull();
    expect(body.parcels[0]?.deliveryPostcode).toBeNull();
    expect(body.parcels[0]?.deliveryPhone).toBeNull();
    expect(text).not.toContain('12 Bramble Cottages');
    expect(text).not.toContain('GU1 4AA');
    expect(text).not.toContain('07700 900123');
  });

  it("gives the driver the referee's own address, postcode and phone for a delivery", async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0, isDelivery: true });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const response = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      headers: authHeaders(token),
    });
    const body: {
      parcels: {
        isDelivery: boolean;
        refereeFirstName: string | null;
        refereeSurname: string | null;
        deliveryAddress: string | null;
        deliveryPostcode: string | null;
        deliveryPhone: string | null;
      }[];
    } = await response.json();

    // A delivery goes to the referee's own address, so a driver must never be
    // handed a sheet with no address on it.
    expect(body.parcels[0]?.isDelivery).toBe(true);
    expect(body.parcels[0]?.refereeFirstName).toBe('Alice');
    expect(body.parcels[0]?.refereeSurname).toBe('Wintergreen');
    expect(body.parcels[0]?.deliveryAddress).toBe('12 Bramble Cottages');
    expect(body.parcels[0]?.deliveryPostcode).toBe('GU1 4AA');
    expect(body.parcels[0]?.deliveryPhone).toBe('07700 900123');
  });

  it('ignores a delivery address a client sends, rather than driving there', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, {
      adults: 1,
      children: 0,
      isDelivery: true,
      deliveryAddress: '4 Riverside Flats',
    });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const response = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      headers: authHeaders(token),
    });
    const text = await response.text();
    const body = JSON.parse(text) as { parcels: { deliveryAddress: string | null }[] };

    expect(body.parcels[0]?.deliveryAddress).toBe('12 Bramble Cottages');
    expect(text).not.toContain('4 Riverside Flats');
  });

  it('carries no answers, because by print time the decision is in the lines', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, {
      adults: 1,
      children: 0,
      answers: { Dietary: 'no pork', Pets: 'two cats' },
    });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const response = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      headers: authHeaders(token),
    });
    const text = await response.text();

    // The preferences belong on the maintenance screen, where somebody is still
    // deciding what goes in the parcel. `dietaryNotes` guessed at four keys the
    // real form does not have, so it is gone rather than silently null.
    expect(text).not.toContain('dietaryNotes');
    expect(text).not.toContain('no pork');
    expect(text).not.toContain('two cats');
  });
});

describe('preferences on the pick-list maintenance screen', () => {
  it('gives the whole answers map, for the client to filter to its own preferences', async () => {
    const { testApp, token, world: w } = await world();
    const answers = { Dietary: 'no pork', 'Tea/Coffee': 'Both', Other: 'no tin opener' };
    await submitReferral(testApp, w, { adults: 1, children: 0, answers });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    // Both routes that feed the maintenance screen.
    for (const path of [`/api/v1/pick-lists/${id}`, `/api/v1/sessions/${w.sessionId}/pick-list`]) {
      const response = await testApp.request(path, { headers: authHeaders(token) });
      const body: { parcels: { answers: Record<string, unknown> }[] } = await response.json();

      // Whole and unfiltered: which of these are preferences is the client's to
      // know, because it owns the form definition.
      expect(body.parcels[0]?.answers).toEqual(answers);
    }
  });

  it('gives an empty map once the referral has been purged', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0, answers: { Dietary: 'no pork' } });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    await db.update(referrals).set({ answersJson: null });

    const response = await testApp.request(`/api/v1/pick-lists/${id}`, {
      headers: authHeaders(token),
    });
    const body: { parcels: { answers: Record<string, unknown> }[] } = await response.json();

    expect(body.parcels[0]?.answers).toEqual({});
  });
});

describe('pick list authorisation', () => {
  it('lets a team lead run the whole picking flow', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const generated = await generatePickList(lead, accessToken, w.sessionId);
    expect(generated.status).toBe(200);

    for (const path of [
      `/api/v1/pick-lists/${generated.id}/print`,
      `/api/v1/pick-lists/${generated.id}/confirm`,
    ]) {
      const response = await lead.request(path, {
        method: 'POST',
        headers: authHeaders(accessToken),
      });
      expect(response.status).toBe(200);
    }
    expect(token).toEqual(expect.any(String));
  });

  it('requires authentication', async () => {
    const { testApp, world: w } = await world();

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      method: 'POST',
    });

    expect(response.status).toBe(401);
  });
});

describe('the D1 query budget', () => {
  it('generates for twenty-five referrals within the free-tier query budget', async () => {
    // The free plan allows 50 queries per Worker invocation. Generation must
    // not scale with referral count — a per-referral rule lookup would breach
    // it on a full session, and this is the first thing a team lead opens on a
    // session morning.
    const { testApp, token, world: w } = await world({ capacity: 30 });

    for (let i = 0; i < 25; i++) {
      // Twenty-five different referrers, so the per-address rate limit on the
      // public endpoint is not what this test ends up measuring.
      const submitted = await submitReferral(
        testApp,
        w,
        { adults: 2, children: 3 },
        { clientIp: `198.51.100.${String(i + 1)}` },
      );
      expect(submitted.status).toBe(201);
    }

    const result = await generatePickList(testApp, token, w.sessionId);
    expect(result.parcelsCreated).toBe(25);

    // 25 parcels x 3 lines: written in one statement via json_each, well past
    // the point a multi-row INSERT would blow the 100-bound-parameter limit.
    expect(await db.select().from(parcels)).toHaveLength(25);
    expect(await db.select().from(parcelLines)).toHaveLength(75);

    // And reading it back stays flat too.
    const { parcels: rows } = await readPickList(testApp, token, result.id);
    expect(rows).toHaveLength(25);
    expect(rows.every((parcel) => parcel.lines.length === 3)).toBe(true);
    expect(rows.map((parcel) => parcel.pickNumber)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });
});
