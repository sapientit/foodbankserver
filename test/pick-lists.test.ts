import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createDatabase } from '../src/db/client.ts';
import {
  NEEDS_ATTENTION_QUANTITY,
  parcelLines,
  parcels,
  pickLists,
} from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { allGridKeys, type ParcelGrid } from '../src/modules/rules/engine.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  addModelParcel,
  generatePickList,
  gridOf,
  readPickList,
  reviewEveryParcel,
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

describe('derivation is what the parcel is chosen by', () => {
  it('a household with one adult and two infants selects the same model parcel as one adult and no children', async () => {
    const { testApp, token, world: w } = await world();

    // Infants are collected and change nothing operational — see
    // `age-bands.ts`. Both households derive to one adult, no children.
    const plain = await submitReferral(testApp, w, {
      infants: 0,
      children4To11: 0,
      teenagers12To17: 0,
      adults18Plus: 1,
    });
    const withInfants = await submitReferral(testApp, w, {
      infants: 2,
      children4To11: 0,
      teenagers12To17: 0,
      adults18Plus: 1,
    });

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);

    const plainParcel = rows.find((p) => p.referralId === plain.id);
    const withInfantsParcel = rows.find((p) => p.referralId === withInfants.id);

    // Asserted on the actual generated lines, not merely on household size.
    expect(plainParcel?.lines).toEqual([
      expect.objectContaining({ stockItemId: w.stockItems.Beans, quantity: 2 }),
    ]);
    expect(withInfantsParcel?.lines).toEqual(plainParcel?.lines);
  });

  it('a teenager counts as an operational adult, picking the two-adults cell rather than one-adult-one-child', async () => {
    const { testApp, token, world: w } = await world();

    // A grid that genuinely distinguishes the two cells this test is about,
    // rather than one where both happen to fall under the same "small"
    // parcel — `gridOf`'s default grid would not catch a bug that swapped
    // the two.
    const twoAdultsParcel = await addModelParcel(testApp, token, 'Two adults, no children', [
      { stockItemId: w.stockItems.Cereal, quantity: 7 },
    ]);
    expect(twoAdultsParcel.status).toBe(201);
    const oneAndOneParcel = await addModelParcel(testApp, token, 'One adult, one child', [
      { stockItemId: w.stockItems.Pasta, quantity: 3 },
    ]);
    expect(oneAndOneParcel.status).toBe(201);

    const grid: ParcelGrid = {};
    for (const key of allGridKeys()) grid[key] = 'Family parcel';
    grid['2-0'] = 'Two adults, no children';
    grid['1-1'] = 'One adult, one child';
    expect((await saveGrid(testApp, token, grid)).status).toBe(200);

    const referral = await submitReferral(testApp, w, {
      infants: 0,
      children4To11: 0,
      teenagers12To17: 1,
      adults18Plus: 1,
    });

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const parcel = rows.find((p) => p.referralId === referral.id);

    // The grid's `2-0` cell, not `1-1`.
    expect(parcel?.lines).toEqual([
      expect.objectContaining({ stockItemId: w.stockItems.Cereal, quantity: 7 }),
    ]);

    // The snapshot the parcel carries is the derived pair too.
    expect(parcel?.adults).toBe(2);
    expect(parcel?.children).toBe(0);
  });

  it('stores the derived adults and children on the parcel snapshot, not the raw bands', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, {
      infants: 3,
      children4To11: 2,
      teenagers12To17: 1,
      adults18Plus: 1,
    });

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);

    // adults = teenagers (1) + 18+ (1) = 2; children = 4-11 (2). Infants (3)
    // are nowhere in the snapshot.
    expect(rows[0]?.adults).toBe(2);
    expect(rows[0]?.children).toBe(2);
  });
});

describe('migration 0023 preserves grid behaviour for a backfilled household', () => {
  // Migration `0023` backfills every pre-existing referral as
  // `{ infants: 0, teenagers12To17: 0, children4To11: <old children>,
  // adults18Plus: <old adults> }`. `test/setup.ts` applies every migration to
  // a fresh database before each test file runs, so there is no row left in
  // this database that predates 0023 — the backfill has already run over
  // zero rows, and there is nothing pre-migration to read back. What can be
  // tested instead is the *property* the backfill exists to preserve: a
  // referral whose bands are in exactly that backfilled shape must resolve
  // through the grid to the same cell, clamp and all, that the old
  // `{ adults, children }` pair resolved to before bands existed.

  it('resolves an ordinary backfilled household to the same grid cell as its old adults/children pair', async () => {
    const { testApp, token, world: w } = await world();

    const referral = await submitReferral(testApp, w, {
      infants: 0,
      teenagers12To17: 0,
      children4To11: 1,
      adults18Plus: 3,
    });

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const parcel = rows.find((p) => p.referralId === referral.id);

    // Old household: 3 adults, 1 child — more than 2 people, so `gridOf`
    // resolves it to the Family parcel.
    expect(parcel?.lines).toHaveLength(3);
    expect(parcel?.adults).toBe(3);
    expect(parcel?.children).toBe(1);
  });

  it('clamps a backfilled household beyond the grid into the same 5x5 corner an old adults:9, children:9 household clamped into', async () => {
    const { testApp, token, world: w } = await world();

    // A model that only the clamped corner resolves to, so a bug that
    // clamped to the wrong nearby cell (5-4, 4-5) would be caught rather than
    // masked by every large household landing on "Family parcel" regardless.
    const jumbo = await addModelParcel(testApp, token, 'Jumbo parcel', [
      { stockItemId: w.stockItems.Cereal, quantity: 20 },
    ]);
    expect(jumbo.status).toBe(201);

    const grid: ParcelGrid = {};
    for (const key of allGridKeys()) grid[key] = 'Family parcel';
    grid['5-5'] = 'Jumbo parcel';
    expect((await saveGrid(testApp, token, grid)).status).toBe(200);

    const referral = await submitReferral(testApp, w, {
      infants: 0,
      teenagers12To17: 0,
      children4To11: 9,
      adults18Plus: 9,
    });

    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const parcel = rows.find((p) => p.referralId === referral.id);

    expect(parcel?.lines).toEqual([
      expect.objectContaining({ stockItemId: w.stockItems.Cereal, quantity: 20 }),
    ]);
    // The snapshot keeps the true, unclamped derived pair; only the grid
    // lookup clamps.
    expect(parcel?.adults).toBe(9);
    expect(parcel?.children).toBe(9);
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

  it('snapshots the household, and correcting the referral reports a divergence rather than moving it', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const { id } = await generatePickList(testApp, token, w.sessionId);

    // The household counts are correctable again, so this is now reachable: a
    // family of one turns out to be a family of three after the picker already
    // has a parcel for one.
    const amended = await testApp.request(`/api/v1/referrals/${referral.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      // `adults`/`children` are no longer accepted on a PATCH — the same
      // operational household (2 adults, 1 child) expressed as bands.
      body: JSON.stringify({
        teenagers12To17: 0,
        adults18Plus: 2,
        children4To11: 1,
        infants: 0,
      }),
    });
    expect(amended.status).toBe(200);

    // The parcel does not move on its own. The picker's snapshot is what is
    // being packed, and rewriting it underneath them is the thing the snapshot
    // exists to prevent.
    const { parcels: rows } = await readPickList(testApp, token, id);
    expect(rows[0]?.adults).toBe(1);
    expect(rows[0]?.children).toBe(0);

    const response = await testApp.request(`/api/v1/pick-lists/${id}/divergence`, {
      headers: authHeaders(token),
    });
    const divergence: {
      changedHouseholds: {
        parcelId: string;
        was: { adults: number; children: number };
        now: { adults: number; children: number };
      }[];
    } = await response.json();

    // Instead it is reported, so a team leader can decide whether to change the
    // parcel. This path was unreachable while the counts were frozen.
    expect(divergence.changedHouseholds).toEqual([
      {
        parcelId: rows[0]?.id,
        was: { adults: 1, children: 0 },
        now: { adults: 2, children: 1 },
      },
    ]);
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
  it('adds an item to a parcel', async () => {
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
  });

  it('puts no source on a parcel line, on the screen or on the sheet', async () => {
    // `source` held 'model' or 'manual' and nothing ever read it. Both payloads
    // are asserted because they share one line shape: a field returning to the
    // maintenance view would silently reappear on the printed sheet too.
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const { parcels: rows } = await readPickList(testApp, token, id);
    expect(rows[0]?.lines[0]).not.toHaveProperty('source');

    await reviewEveryParcel(testApp, token, id);
    const printed = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      headers: authHeaders(token),
    });
    const body: { parcels: { lines: Record<string, unknown>[] }[] } = await printed.json();
    expect(body.parcels[0]?.lines[0]).not.toHaveProperty('source');
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
    await reviewEveryParcel(testApp, token, id);

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

describe('parcel line descriptions', () => {
  it('carries null for a line whose stock item has no description', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const { parcels: rows } = await readPickList(testApp, token, id);
    expect(rows[0]?.lines).not.toHaveLength(0);
    expect(rows[0]?.lines.every((line) => line.description === null)).toBe(true);
  });

  it('carries the stock item description on both the maintenance view and the print sheet', async () => {
    const { testApp, token, world: w } = await world();
    await testApp.request(`/api/v1/stock/items/${w.stockItems.Beans}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ description: '400g tin' }),
    });
    await submitReferral(testApp, w, { adults: 2, children: 3 });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const { parcels: rows } = await readPickList(testApp, token, id);
    const beansLine = rows[0]?.lines.find((line) => line.stockItemId === w.stockItems.Beans);
    expect(beansLine?.description).toBe('400g tin');
    // No category on a parcel line: the sheet is walked in shelf order, and
    // grouping by category belongs to the stock item list, not here.
    expect(beansLine).not.toHaveProperty('category');

    await reviewEveryParcel(testApp, token, id);
    const printed = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      headers: authHeaders(token),
    });
    const printedBody: {
      parcels: { lines: { stockItemId: string; description: string | null }[] }[];
    } = await printed.json();
    const printedBeansLine = printedBody.parcels[0]?.lines.find(
      (line) => line.stockItemId === w.stockItems.Beans,
    );
    expect(printedBeansLine?.description).toBe('400g tin');
    expect(printedBeansLine).not.toHaveProperty('category');
  });
});

describe('printing an unreviewed list', () => {
  it('refuses the print payload until every parcel has been reviewed', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    await submitReferral(testApp, w, { adults: 2, children: 3 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);

    // One reviewed household is not enough: the other's parcel would go on the
    // same run of sheets with its decision still open.
    await testApp.request(`/api/v1/parcels/${rows[0]?.id ?? ''}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const refused = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      headers: authHeaders(token),
    });
    expect(refused.status).toBe(409);

    await reviewEveryParcel(testApp, token, id);
    const allowed = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      headers: authHeaders(token),
    });
    expect(allowed.status).toBe(200);
  });

  it('refuses to stamp the list as printed until every parcel has been reviewed', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const refused = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(refused.status).toBe(409);
    expect((await readPickList(testApp, token, id)).pickList.status).toBe('draft');

    await reviewEveryParcel(testApp, token, id);
    const allowed = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(allowed.status).toBe(200);
  });

  it('refuses a reprint once a late referral has added an unreviewed parcel', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, id);

    const printed = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(printed.status).toBe(200);

    // Reconciliation adds the newcomer's parcel unreviewed, so the second run
    // of sheets is refused even though the list is already stamped.
    await submitReferral(testApp, w, { adults: 2, children: 3 });
    await generatePickList(testApp, token, w.sessionId);

    for (const method of ['GET', 'POST']) {
      const response = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
        method,
        headers: authHeaders(token),
      });
      expect(response.status).toBe(409);
    }
  });
});

describe('the printed sheet', () => {
  it('orders lines by shelf so a picker walks the aisle once', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 2, children: 3 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, id);

    const response = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      headers: authHeaders(token),
    });
    const body: { parcels: { lines: { name: string; shelfNumber: string }[] }[] } =
      await response.json();

    // Cereal A1, Beans A2, Pasta A10 — not alphabetical, not insertion order.
    expect(body.parcels[0]?.lines.map((l) => l.name)).toEqual(['Cereal', 'Beans', 'Pasta']);
  });

  it('orders parcel lines on the maintenance view by shelf too', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 2, children: 3 });
    const { id } = await generatePickList(testApp, token, w.sessionId);

    const { parcels: rows } = await readPickList(testApp, token, id);

    // Cereal A1, Beans A2, Pasta A10 is shelf order. Category order would
    // read Cereal (Breakfast), Pasta (Dried Goods), Beans (Tinned Goods) —
    // Beans and Pasta swapped — so this genuinely distinguishes the two.
    expect(rows[0]?.lines.map((line) => line.name)).toEqual(['Cereal', 'Beans', 'Pasta']);
  });

  it('never carries the reason for referral', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 2, children: 3 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    await reviewEveryParcel(testApp, token, id);

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
    await reviewEveryParcel(testApp, token, id);

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
    await reviewEveryParcel(testApp, token, id);

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
    await reviewEveryParcel(testApp, token, id);

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
    await reviewEveryParcel(testApp, token, id);

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
    await reviewEveryParcel(lead, accessToken, generated.id);

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

describe('preference lines at generation', () => {
  it('raises a line to the preference quantity when it asks for more than the model', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const result = await generatePickList(testApp, token, w.sessionId, [
      { referralId: referral.id, lines: [{ stockItemId: w.stockItems.Beans, quantity: 5 }] },
    ]);
    expect(result.status).toBe(200);
    expect(result.preferenceLinesApplied).toBe(1);
    expect(result.preferenceLinesDropped).toBe(0);
    expect(result.preferenceReferralsIgnored).toBe(0);

    const { parcels: rows } = await readPickList(testApp, token, result.id);
    expect(rows[0]?.lines).toEqual([
      expect.objectContaining({ stockItemId: w.stockItems.Beans, quantity: 5 }),
    ]);
  });

  it('never lowers a line below what the model already gives the household', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    // The Single parcel model already gives two tins of Beans; the preference
    // asks for fewer, which must not cut a household's share.
    const result = await generatePickList(testApp, token, w.sessionId, [
      { referralId: referral.id, lines: [{ stockItemId: w.stockItems.Beans, quantity: 1 }] },
    ]);
    expect(result.status).toBe(200);

    const { parcels: rows } = await readPickList(testApp, token, result.id);
    expect(rows[0]?.lines).toEqual([
      expect.objectContaining({ stockItemId: w.stockItems.Beans, quantity: 2 }),
    ]);
  });

  it('adds an item to the parcel that the model does not contain', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    // The Single parcel model contains only Beans.
    const result = await generatePickList(testApp, token, w.sessionId, [
      { referralId: referral.id, lines: [{ stockItemId: w.stockItems.Cereal, quantity: 1 }] },
    ]);
    expect(result.status).toBe(200);
    expect(result.preferenceLinesApplied).toBe(1);

    const { parcels: rows } = await readPickList(testApp, token, result.id);
    expect(rows[0]?.lines.map((l) => l.stockItemId).sort()).toEqual(
      [w.stockItems.Beans, w.stockItems.Cereal].sort(),
    );
  });

  it('collapses a preference that repeats a model item into exactly one row', async () => {
    // A database-level assertion, not a response-shape one: `parcel_lines` is
    // uniquely indexed on (parcel_id, stock_item_id) and the bulk insert has no
    // ON CONFLICT, so a duplicate here would fail the whole atomic batch rather
    // than merely look wrong in the response.
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const result = await generatePickList(testApp, token, w.sessionId, [
      { referralId: referral.id, lines: [{ stockItemId: w.stockItems.Beans, quantity: 9 }] },
    ]);
    expect(result.status).toBe(200);

    const [parcel] = await db.select().from(parcels).where(eq(parcels.referralId, referral.id));
    const beansRows = await db
      .select()
      .from(parcelLines)
      .where(
        and(
          eq(parcelLines.parcelId, parcel?.id ?? ''),
          eq(parcelLines.stockItemId, w.stockItems.Beans),
        ),
      );

    expect(beansRows).toHaveLength(1);
    expect(beansRows[0]?.quantity).toBe(9);
  });

  it('refuses the whole request and writes nothing when a stock item id is unknown', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const unknownId = crypto.randomUUID();

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        preferenceLines: [
          { referralId: referral.id, lines: [{ stockItemId: unknownId, quantity: 1 }] },
        ],
      }),
    });

    expect(response.status).toBe(422);
    const body: { error: { details?: { unknownStockItemIds?: string[] } } } = await response.json();
    expect(body.error.details?.unknownStockItemIds).toEqual([unknownId]);

    // Nothing was written: not the pick list, not a parcel.
    expect(await db.select().from(pickLists)).toHaveLength(0);
    const check = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      headers: authHeaders(token),
    });
    expect(check.status).toBe(404);
  });

  it('drops a preference line for a deactivated stock item and still generates', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    await testApp.request(`/api/v1/stock/items/${w.stockItems.Cereal}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });

    const result = await generatePickList(testApp, token, w.sessionId, [
      { referralId: referral.id, lines: [{ stockItemId: w.stockItems.Cereal, quantity: 3 }] },
    ]);

    expect(result.status).toBe(200);
    expect(result.preferenceLinesApplied).toBe(0);
    expect(result.preferenceLinesDropped).toBe(1);

    const { parcels: rows } = await readPickList(testApp, token, result.id);
    expect(rows[0]?.lines.map((l) => l.stockItemId)).toEqual([w.stockItems.Beans]);
  });

  it('ignores preference lines for a referral that already has a parcel', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const first = await generatePickList(testApp, token, w.sessionId);
    expect(first.parcelsCreated).toBe(1);

    // Sent as part of the whole session's lines on a later reconciliation, for
    // a household that was already picked. Never an error: that is what makes
    // sending the whole set every time safe for the client.
    const reconciled = await generatePickList(testApp, token, w.sessionId, [
      { referralId: referral.id, lines: [{ stockItemId: w.stockItems.Beans, quantity: 99 }] },
    ]);

    expect(reconciled.status).toBe(200);
    expect(reconciled.parcelsCreated).toBe(0);
    expect(reconciled.preferenceLinesApplied).toBe(0);
    expect(reconciled.preferenceReferralsIgnored).toBe(1);

    // The existing parcel is untouched, not bumped to 99.
    const { parcels: rows } = await readPickList(testApp, token, first.id);
    expect(rows[0]?.lines).toEqual([
      expect.objectContaining({ stockItemId: w.stockItems.Beans, quantity: 2 }),
    ]);
  });

  it('ignores preference lines for a referral that is on the session but cancelled', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    await testApp.request(`/api/v1/referrals/${referral.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const result = await generatePickList(testApp, token, w.sessionId, [
      { referralId: referral.id, lines: [{ stockItemId: w.stockItems.Beans, quantity: 5 }] },
    ]);

    // Not refused: a cancelled referral is still on the session, just not
    // owed a parcel — an ordinary race, unlike an id from another session.
    expect(result.status).toBe(200);
    expect(result.parcelsCreated).toBe(0);
    expect(result.preferenceLinesApplied).toBe(0);
    expect(result.preferenceReferralsIgnored).toBe(1);
    expect(await db.select().from(parcels)).toHaveLength(0);
  });

  it('refuses the whole request and writes nothing when a preference line names a referral that is not on the session', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });

    // A referral submitted to a different session entirely.
    const otherSession = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate: '2026-08-18',
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Hall',
      }),
    });
    const { id: otherSessionId }: { id: string } = await otherSession.json();
    const elsewhere = await submitReferral(testApp, w, {
      adults: 1,
      children: 0,
      sessionId: otherSessionId,
    });

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        preferenceLines: [
          { referralId: elsewhere.id, lines: [{ stockItemId: w.stockItems.Beans, quantity: 5 }] },
        ],
      }),
    });

    expect(response.status).toBe(422);
    const body: {
      error: { message: string; details?: { offSessionReferralIds?: string[] } };
    } = await response.json();
    expect(body.error.message).toBe('Preference lines name referrals that are not on this session');
    expect(body.error.details?.offSessionReferralIds).toEqual([elsewhere.id]);

    // Nothing was written: not the pick list, not a parcel for the household
    // that *was* on the session and would otherwise have been picked.
    expect(await db.select().from(pickLists)).toHaveLength(0);
    const check = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      headers: authHeaders(token),
    });
    expect(check.status).toBe(404);
  });

  it('refuses a request naming the same stock item twice for one referral', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        preferenceLines: [
          {
            referralId: referral.id,
            lines: [
              { stockItemId: w.stockItems.Beans, quantity: 1 },
              { stockItemId: w.stockItems.Beans, quantity: 2 },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(await db.select().from(pickLists)).toHaveLength(0);
  });

  it('refuses a request naming the same referral twice', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        preferenceLines: [
          { referralId: referral.id, lines: [{ stockItemId: w.stockItems.Beans, quantity: 1 }] },
          { referralId: referral.id, lines: [{ stockItemId: w.stockItems.Cereal, quantity: 1 }] },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(await db.select().from(pickLists)).toHaveLength(0);
  });

  it('a needs-attention line survives generation and cannot be reviewed', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const result = await generatePickList(testApp, token, w.sessionId, [
      {
        referralId: referral.id,
        lines: [{ stockItemId: w.stockItems.Beans, quantity: NEEDS_ATTENTION_QUANTITY }],
      },
    ]);
    expect(result.status).toBe(200);
    expect(result.preferenceLinesApplied).toBe(1);

    const { parcels: rows } = await readPickList(testApp, token, result.id);
    expect(rows[0]?.lines).toEqual([
      expect.objectContaining({
        stockItemId: w.stockItems.Beans,
        quantity: NEEDS_ATTENTION_QUANTITY,
      }),
    ]);

    // The whole point: a picker cannot be sent to fetch "-1" of anything, and
    // the review gate is what keeps it off a printed sheet and off the ledger.
    const review = await testApp.request(`/api/v1/parcels/${rows[0]?.id ?? ''}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(review.status).toBe(409);
    expect(await review.json()).toMatchObject({
      error: { message: 'Settle every item needing attention before reviewing this parcel' },
    });
  });

  it('a needs-attention line blocks printing, even once every other parcel has been reviewed', async () => {
    // Enforced transitively today — a needs-attention line blocks review, and
    // printing requires every parcel reviewed — so this drives the real
    // routes end to end rather than asserting the mechanism directly.
    const { testApp, token, world: w } = await world();
    const settled = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const stuck = await submitReferral(testApp, w, { adults: 2, children: 3 });

    const result = await generatePickList(testApp, token, w.sessionId, [
      {
        referralId: stuck.id,
        lines: [{ stockItemId: w.stockItems.Beans, quantity: NEEDS_ATTENTION_QUANTITY }],
      },
    ]);
    expect(result.status).toBe(200);

    const { parcels: rows } = await readPickList(testApp, token, result.id);
    const settledParcel = rows.find((p) => p.referralId === settled.id);
    const stuckParcel = rows.find((p) => p.referralId === stuck.id);

    // Every *other* parcel is reviewed; the one carrying the -1 is left alone.
    const reviewedSettled = await testApp.request(
      `/api/v1/parcels/${settledParcel?.id ?? ''}/review`,
      { method: 'POST', headers: authHeaders(token) },
    );
    expect(reviewedSettled.status).toBe(200);

    for (const method of ['GET', 'POST']) {
      const response = await testApp.request(`/api/v1/pick-lists/${result.id}/print`, {
        method,
        headers: authHeaders(token),
      });
      expect(response.status, method).toBe(409);
    }

    // Settling the stuck parcel's decision unblocks both: it is not the
    // review gate itself under test, but that the chain really is unbroken.
    const settledLine = await testApp.request(`/api/v1/parcels/${stuckParcel?.id ?? ''}/lines`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ stockItemId: w.stockItems.Beans, quantity: 4 }),
    });
    expect(settledLine.status).toBe(204);
    const nowReviewable = await testApp.request(`/api/v1/parcels/${stuckParcel?.id ?? ''}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(nowReviewable.status).toBe(200);

    const printed = await testApp.request(`/api/v1/pick-lists/${result.id}/print`, {
      headers: authHeaders(token),
    });
    expect(printed.status).toBe(200);
  });

  it('a needs-attention line blocks issuing the parcel to stock, and leaves the ledger untouched', async () => {
    // `buildParcelIssue` negates the line quantity to move it off the
    // shelves. A `-1` reaching attendance would therefore *add* one to
    // stock rather than refuse — which is exactly why this must never get
    // that far, and why the assertion below is on the ledger, not only on
    // the status code.
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const result = await generatePickList(testApp, token, w.sessionId, [
      {
        referralId: referral.id,
        lines: [{ stockItemId: w.stockItems.Beans, quantity: NEEDS_ATTENTION_QUANTITY }],
      },
    ]);
    expect(result.status).toBe(200);
    const { parcels: rows } = await readPickList(testApp, token, result.id);
    const parcelId = rows[0]?.id ?? '';

    // Unreviewed, because the needs-attention line refuses review — see the
    // test above. Attendance requires review first, so this is refused too.
    const attendance = await testApp.request(`/api/v1/parcels/${parcelId}/attendance`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ attendance: 'attended' }),
    });
    expect(attendance.status).toBe(409);

    expect(await db.select().from(stockLedger)).toHaveLength(0);
  });

  it.each([[0], [-2], [1.5], [1001]])('refuses a preference quantity of %s', async (quantity) => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        preferenceLines: [
          { referralId: referral.id, lines: [{ stockItemId: w.stockItems.Beans, quantity }] },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(await db.select().from(pickLists)).toHaveLength(0);
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

  it('carries preference lines for twenty-five referrals within budget, one catalogue query however many items are named', async () => {
    // The stock catalogue is fetched whole, once, rather than once per named
    // item — `inArray` would bind one parameter per id against a limit of 100,
    // and a per-referral lookup would burn the same 50-query budget the plain
    // generation test above exists to prove is flat.
    const { testApp, token, world: w } = await world({ capacity: 30 });

    const referralIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const submitted = await submitReferral(
        testApp,
        w,
        { adults: 2, children: 3 },
        { clientIp: `198.51.100.${String(i + 1)}` },
      );
      expect(submitted.status).toBe(201);
      referralIds.push(submitted.id);
    }

    const preferenceLines = referralIds.map((referralId) => ({
      referralId,
      // Higher than the Family parcel model's Beans quantity of 4, so every
      // parcel's line is provably the merged value rather than the model's.
      lines: [{ stockItemId: w.stockItems.Beans, quantity: 5 }],
    }));

    const result = await generatePickList(testApp, token, w.sessionId, preferenceLines);
    expect(result.status).toBe(200);
    expect(result.parcelsCreated).toBe(25);
    expect(result.preferenceLinesApplied).toBe(25);
    expect(result.preferenceLinesDropped).toBe(0);
    expect(result.preferenceReferralsIgnored).toBe(0);

    // Still one row per stock item per parcel — no duplicate Beans line from
    // merging the model's with the preference's.
    expect(await db.select().from(parcels)).toHaveLength(25);
    const lines = await db.select().from(parcelLines);
    expect(lines).toHaveLength(75);
    expect(lines.filter((line) => line.stockItemId === w.stockItems.Beans)).toHaveLength(25);
    expect(
      lines
        .filter((line) => line.stockItemId === w.stockItems.Beans)
        .every((line) => line.quantity === 5),
    ).toBe(true);
  });
});
