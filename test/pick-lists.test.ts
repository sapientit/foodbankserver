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
import { createReferralsRepository } from '../src/modules/referrals/referrals.repository.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
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
      body: JSON.stringify({ adults: 2, children: 1 }),
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

  it('carries the saved pick-list note, but still never the answers or the reason for referral', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, {
      adults: 1,
      children: 0,
      answers: { Dietary: 'no pork', Pets: 'two cats' },
    });
    const { id } = await generatePickList(testApp, token, w.sessionId, undefined, [
      { referralId: referral.id, notes: 'Allergies: 2 people who are vegan.' },
    ]);
    await reviewEveryParcel(testApp, token, id);

    const response = await testApp.request(`/api/v1/pick-lists/${id}/print`, {
      headers: authHeaders(token),
    });
    const text = await response.text();
    const body = JSON.parse(text) as { parcels: { notes: string | null }[] };

    expect(body.parcels[0]?.notes).toBe('Allergies: 2 people who are vegan.');
    expect(text).not.toContain('answers');
    expect(text).not.toContain('no pork');
    expect(text).not.toContain('two cats');
    expect(text).not.toContain('reasonId');
    expect(text).not.toContain(w.reasonId);
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

describe('pick-list information at generation', () => {
  it('writes the annotation onto a parcel this call creates', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const result = await generatePickList(testApp, token, w.sessionId, undefined, [
      {
        referralId: referral.id,
        notes: 'Allergies: 2 people who are vegan.\nBeans: Kidney beans please.',
      },
    ]);
    expect(result.status).toBe(200);

    const { parcels: rows } = await readPickList(testApp, token, result.id);
    expect(rows[0]?.notes).toBe('Allergies: 2 people who are vegan.\nBeans: Kidney beans please.');
  });

  it('never overwrites a note a team leader has since edited via PATCH, even when reconciliation resends it', async () => {
    const { testApp, token, world: w } = await world();
    const referralA = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const original = [{ referralId: referralA.id, notes: 'Original note from the form.' }];
    const first = await generatePickList(testApp, token, w.sessionId, undefined, original);
    expect(first.status).toBe(200);
    expect(first.parcelsCreated).toBe(1);

    const { parcels: firstRows } = await readPickList(testApp, token, first.id);
    const parcelA = firstRows.find((p) => p.referralId === referralA.id);

    const patch = await testApp.request(`/api/v1/parcels/${parcelA?.id ?? ''}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'Edited by the team leader.' }),
    });
    expect(patch.status).toBe(200);

    const referralB = await submitReferral(testApp, w, { adults: 1, children: 0 });

    // Sent again, unchanged, alongside a fresh entry for the newly-arrived
    // household — the reconciliation the client actually performs.
    const reconciled = await generatePickList(testApp, token, w.sessionId, undefined, [
      ...original,
      { referralId: referralB.id, notes: 'New household note.' },
    ]);
    expect(reconciled.status).toBe(200);
    expect(reconciled.parcelsCreated).toBe(1);

    const { parcels: rows } = await readPickList(testApp, token, first.id);
    const stillA = rows.find((p) => p.referralId === referralA.id);
    const nowB = rows.find((p) => p.referralId === referralB.id);
    expect(stillA?.notes).toBe('Edited by the team leader.');
    expect(nowB?.notes).toBe('New household note.');
  });

  it("gives each newly created parcel only its own referral's annotation, and null for one with none", async () => {
    const { testApp, token, world: w } = await world();
    const withNote = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const withoutNote = await submitReferral(testApp, w, { adults: 2, children: 0 });

    const result = await generatePickList(testApp, token, w.sessionId, undefined, [
      { referralId: withNote.id, notes: 'Only for this household.' },
    ]);
    expect(result.status).toBe(200);
    expect(result.parcelsCreated).toBe(2);

    const { parcels: rows } = await readPickList(testApp, token, result.id);
    const notedParcel = rows.find((p) => p.referralId === withNote.id);
    const unnotedParcel = rows.find((p) => p.referralId === withoutNote.id);
    expect(notedParcel?.notes).toBe('Only for this household.');
    expect(unnotedParcel?.notes).toBeNull();
  });

  it('refuses pick-list information naming the same referral twice', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        pickListInformation: [
          { referralId: referral.id, notes: 'First.' },
          { referralId: referral.id, notes: 'Second.' },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(await db.select().from(pickLists)).toHaveLength(0);
  });

  it('refuses the whole request and writes nothing when pick-list information names a referral that is not on the session', async () => {
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
        pickListInformation: [{ referralId: elsewhere.id, notes: 'Wrong session.' }],
      }),
    });

    expect(response.status).toBe(422);
    const body: {
      error: { message: string; details?: { offSessionReferralIds?: string[] } };
    } = await response.json();
    expect(body.error.message).toBe(
      'Pick-list information names referrals that are not on this session',
    );
    expect(body.error.details?.offSessionReferralIds).toEqual([elsewhere.id]);

    // Nothing was written: not the pick list, not a parcel for the household
    // that *was* on the session and would otherwise have been picked.
    expect(await db.select().from(pickLists)).toHaveLength(0);
    const check = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      headers: authHeaders(token),
    });
    expect(check.status).toBe(404);
  });

  it('ignores pick-list information for a referral that already has a parcel', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const first = await generatePickList(testApp, token, w.sessionId);
    expect(first.parcelsCreated).toBe(1);

    const reconciled = await generatePickList(testApp, token, w.sessionId, undefined, [
      { referralId: referral.id, notes: 'Too late, already picked.' },
    ]);

    expect(reconciled.status).toBe(200);
    expect(reconciled.parcelsCreated).toBe(0);

    // The existing parcel's note is untouched, still null.
    const { parcels: rows } = await readPickList(testApp, token, first.id);
    expect(rows[0]?.notes).toBeNull();
  });

  it('ignores pick-list information for a referral that is on the session but cancelled', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    await testApp.request(`/api/v1/referrals/${referral.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const result = await generatePickList(testApp, token, w.sessionId, undefined, [
      { referralId: referral.id, notes: 'Should never be written.' },
    ]);

    // Not refused: a cancelled referral is still on the session, just not
    // owed a parcel — an ordinary race, unlike an id from another session.
    expect(result.status).toBe(200);
    expect(result.parcelsCreated).toBe(0);
    expect(await db.select().from(parcels)).toHaveLength(0);
  });

  it('ignores pick-list information for a referral that is on the session but rejected', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, {
      adults: 1,
      children: 0,
      ...UNKNOWN_REFERRER,
    });
    expect(referral.referralStatus).toBe('pending_review');

    const reject = await testApp.request(`/api/v1/referrals/${referral.id}/reject`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(reject.status).toBe(200);

    const result = await generatePickList(testApp, token, w.sessionId, undefined, [
      { referralId: referral.id, notes: 'Should never be written.' },
    ]);

    expect(result.status).toBe(200);
    expect(result.parcelsCreated).toBe(0);
    expect(await db.select().from(parcels)).toHaveLength(0);
  });

  it('refuses an empty or whitespace-only note', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    for (const notes of ['', '   ']) {
      const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ pickListInformation: [{ referralId: referral.id, notes }] }),
      });
      expect(response.status, notes).toBe(400);
    }
    expect(await db.select().from(pickLists)).toHaveLength(0);
  });

  it('accepts a note of exactly 1200 characters and refuses one of 1201', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const withinLimit = 'a'.repeat(1200);
    const overLimit = 'a'.repeat(1201);

    const refused = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        pickListInformation: [{ referralId: referral.id, notes: overLimit }],
      }),
    });
    expect(refused.status).toBe(400);
    expect(await db.select().from(pickLists)).toHaveLength(0);

    const accepted = await generatePickList(testApp, token, w.sessionId, undefined, [
      { referralId: referral.id, notes: withinLimit },
    ]);
    expect(accepted.status).toBe(200);

    const { parcels: rows } = await readPickList(testApp, token, accepted.id);
    expect(rows[0]?.notes).toBe(withinLimit);
  });
});

describe('editing a parcel note', () => {
  it('sets and then clears a parcel note via PATCH', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const parcelId = rows[0]?.id ?? '';

    const set = await testApp.request(`/api/v1/parcels/${parcelId}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'Handle with care.' }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ id: parcelId, notes: 'Handle with care.' });

    const afterSet = await readPickList(testApp, token, id);
    expect(afterSet.parcels[0]?.notes).toBe('Handle with care.');

    const clear = await testApp.request(`/api/v1/parcels/${parcelId}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ notes: null }),
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toEqual({ id: parcelId, notes: null });

    const afterClear = await readPickList(testApp, token, id);
    expect(afterClear.parcels[0]?.notes).toBeNull();
  });

  it('refuses to edit a parcel note once the pick list has been confirmed', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const parcelId = rows[0]?.id ?? '';

    const confirmed = await testApp.request(`/api/v1/pick-lists/${id}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(confirmed.status).toBe(200);

    const patch = await testApp.request(`/api/v1/parcels/${parcelId}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'Too late.' }),
    });
    expect(patch.status).toBe(409);

    // Nothing changed underneath the refusal.
    const [row] = await db.select().from(parcels).where(eq(parcels.id, parcelId));
    expect(row?.notes).toBeNull();
  });

  it('accepts a PATCH note of exactly 1200 characters and refuses one of 1201', async () => {
    const { testApp, token, world: w } = await world();
    await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, id);
    const parcelId = rows[0]?.id ?? '';
    const withinLimit = 'b'.repeat(1200);
    const overLimit = 'b'.repeat(1201);

    const refused = await testApp.request(`/api/v1/parcels/${parcelId}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ notes: overLimit }),
    });
    expect(refused.status).toBe(400);

    const accepted = await testApp.request(`/api/v1/parcels/${parcelId}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ notes: withinLimit }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ id: parcelId, notes: withinLimit });
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

describe('cancelling a referral after its parcel has been picked', () => {
  /**
   * One household that stays active and three that get cancelled after
   * generation, all four already carrying a parcel — the shape a real
   * session produces once a team leader starts trimming no-shows before the
   * day even starts.
   */
  async function buildCancelledScenario() {
    const { testApp, token, world: w } = await world();
    const active = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const cancelled: Awaited<ReturnType<typeof submitReferral>>[] = [];
    for (let i = 0; i < 3; i++) {
      cancelled.push(await submitReferral(testApp, w, { adults: 2, children: 0 }));
    }

    const generated = await generatePickList(testApp, token, w.sessionId, undefined, [
      { referralId: active.id, notes: 'Keep me.' },
      ...cancelled.map((referral, i) => ({
        referralId: referral.id,
        notes: `Cancel me ${String(i)}.`,
      })),
    ]);
    expect(generated.parcelsCreated).toBe(4);

    const before = await readPickList(testApp, token, generated.id);

    for (const referral of cancelled) {
      const response = await testApp.request(`/api/v1/referrals/${referral.id}/cancel`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      expect(response.status).toBe(200);
    }

    return { testApp, token, w, active, cancelled, pickListId: generated.id, before };
  }

  it("marks each cancelled household's parcel cancelled, leaves its contents and pick number untouched, and leaves the active one pending", async () => {
    const { testApp, token, active, pickListId, before } = await buildCancelledScenario();

    const after = await readPickList(testApp, token, pickListId);
    expect(after.parcels).toHaveLength(4);

    // Nothing about the row itself moved: same id, same pick number, same
    // lines, same note — cancelling flips a flag, it does not rewrite the
    // snapshot.
    for (const beforeParcel of before.parcels) {
      const afterParcel = after.parcels.find((p) => p.id === beforeParcel.id);
      expect(afterParcel?.pickNumber).toBe(beforeParcel.pickNumber);
      expect(afterParcel?.lines).toEqual(beforeParcel.lines);
      expect(afterParcel?.notes).toBe(beforeParcel.notes);
    }

    const activeParcel = after.parcels.find((p) => p.referralId === active.id);
    expect(activeParcel?.attendance).toBe('pending');

    const cancelledParcels = after.parcels.filter((p) => p.referralId !== active.id);
    expect(cancelledParcels).toHaveLength(3);
    expect(cancelledParcels.every((p) => p.attendance === 'cancelled')).toBe(true);
  });

  /**
   * The session-scoped route specifically, not `GET /pick-lists/{id}` which
   * the helper above uses. It is the one the run-session screen calls, and it
   * resolves referrals separately — a cancelled household must still come back
   * with the name its sheet was picked against, or the screen loses the only
   * thing that says whose pick number is being stood down.
   */
  it('returns the cancelled parcels, named, from the session pick-list route', async () => {
    const { testApp, token, w, active } = await buildCancelledScenario();

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}/pick-list`, {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);

    const body: {
      parcels: { referralId: string; attendance: string; refereeSurname: string | null }[];
    } = await response.json();

    expect(body.parcels).toHaveLength(4);
    const byReferral = new Map(body.parcels.map((parcel) => [parcel.referralId, parcel]));
    expect(byReferral.get(active.id)?.attendance).toBe('pending');

    for (const parcel of body.parcels.filter((p) => p.referralId !== active.id)) {
      expect(parcel.attendance).toBe('cancelled');
      expect(parcel.refereeSurname).not.toBeNull();
    }
  });

  it("counts only the active household toward the session's booked total", async () => {
    const { testApp, token, w } = await buildCancelledScenario();

    const response = await testApp.request(`/api/v1/sessions/${w.sessionId}`, {
      headers: authHeaders(token),
    });
    const body: { booked: number } = await response.json();

    expect(body.booked).toBe(1);
  });

  it('excludes the cancelled households from referral-details and the listener sheet', async () => {
    const { testApp, token, w, active } = await buildCancelledScenario();

    const details = await testApp.request(`/api/v1/sessions/${w.sessionId}/referral-details`, {
      headers: authHeaders(token),
    });
    const detailsBody: { referrals: { referralId: string }[] } = await details.json();
    expect(detailsBody.referrals.map((r) => r.referralId)).toEqual([active.id]);

    const sheet = await testApp.request(`/api/v1/sessions/${w.sessionId}/listener-sheet`, {
      headers: authHeaders(token),
    });
    const sheetBody: { households: { referralId: string }[] } = await sheet.json();
    expect(sheetBody.households.map((h) => h.referralId)).toEqual([active.id]);
  });

  it('prints once the active parcel is reviewed, leaving the never-reviewed cancelled parcels off the sheet', async () => {
    const { testApp, token, active, pickListId } = await buildCancelledScenario();
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    const activeParcel = rows.find((p) => p.referralId === active.id);

    // Before this change, an unreviewed cancelled parcel would have 409'd
    // both of these.
    const review = await testApp.request(`/api/v1/parcels/${activeParcel?.id ?? ''}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(review.status).toBe(200);

    const printed = await testApp.request(`/api/v1/pick-lists/${pickListId}/print`, {
      headers: authHeaders(token),
    });
    expect(printed.status).toBe(200);
    const body: { parcels: { pickNumber: number }[] } = await printed.json();
    expect(body.parcels).toHaveLength(1);
    expect(body.parcels[0]?.pickNumber).toBe(activeParcel?.pickNumber);

    const stamped = await testApp.request(`/api/v1/pick-lists/${pickListId}/print`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(stamped.status).toBe(200);
  });

  it('does not block confirming the session once the active household has an outcome', async () => {
    const { testApp, token, w, active, pickListId } = await buildCancelledScenario();
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    const activeParcel = rows.find((p) => p.referralId === active.id);

    await testApp.request(`/api/v1/parcels/${activeParcel?.id ?? ''}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    const attendance = await testApp.request(
      `/api/v1/parcels/${activeParcel?.id ?? ''}/attendance`,
      {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ attendance: 'attended' }),
      },
    );
    expect(attendance.status).toBe(200);

    const confirmed = await testApp.request(`/api/v1/sessions/${w.sessionId}/confirm`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(confirmed.status).toBe(200);
  });

  it('refuses to record attendance against a cancelled parcel', async () => {
    const { testApp, token, active, pickListId } = await buildCancelledScenario();
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    const cancelledParcel = rows.find((p) => p.referralId !== active.id);

    const response = await testApp.request(
      `/api/v1/parcels/${cancelledParcel?.id ?? ''}/attendance`,
      {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ attendance: 'attended' }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { message: 'That household has cancelled' },
    });
  });

  it('refuses to cancel a referral whose parcel has already been marked attended', async () => {
    // The charity settled on 2026-08-15 that a household who has collected can
    // no longer be cancelled at all — `INITIAL_SPEC1.txt`, `#Referral
    // maintenance`. This test used to assert the superseded rule, that the
    // cancellation went through and only the parcel's recorded outcome was left
    // alone. Now the cancellation itself is refused, so the parcel's `pending`
    // guard is never reached and the outcome survives for a stronger reason.
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    const parcelId = rows[0]?.id ?? '';

    await testApp.request(`/api/v1/parcels/${parcelId}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    const attendance = await testApp.request(`/api/v1/parcels/${parcelId}/attendance`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ attendance: 'attended' }),
    });
    expect(attendance.status).toBe(200);

    // The session is still open — only attendance was recorded above, not
    // confirmation — so the refusal below is the outcome rule and not the
    // confirmed-session one.
    const cancelled = await testApp.request(`/api/v1/referrals/${referral.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(cancelled.status).toBe(409);

    // Nothing moved: the parcel keeps its outcome and the referral is not
    // cancelled. The batch is conditioned on the same test, so a partial write
    // would show up here as one of these two disagreeing with the other.
    const after = await readPickList(testApp, token, pickListId);
    expect(after.parcels[0]?.attendance).toBe('attended');

    const referralAfter = await testApp.request(`/api/v1/referrals/${referral.id}`, {
      headers: authHeaders(token),
    });
    expect(await referralAfter.json()).toMatchObject({ status: 'active', outcome: 'attended' });
  });

  it('cancelling twice leaves the parcel cancelled and does not error', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);

    const first = await testApp.request(`/api/v1/referrals/${referral.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(first.status).toBe(200);

    const second = await testApp.request(`/api/v1/referrals/${referral.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    expect(second.status).toBe(200);

    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    expect(rows[0]?.attendance).toBe('cancelled');
  });
});

describe('moving a referral to another session', () => {
  /**
   * Contrast with `describe('cancelling a referral after its parcel has
   * been picked', …)` above: cancelling marks a parcel `cancelled` and keeps
   * it; moving deletes it. Both are proven here so the difference stays a
   * checked rule rather than something the next reader has to re-derive.
   */

  async function createSession(
    testApp: TestApp,
    token: string,
    sessionDate: string,
  ): Promise<string> {
    const response = await testApp.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionDate,
        startTime: '10:00',
        durationMinutes: 120,
        location: 'Annexe',
        capacity: 25,
      }),
    });
    const { id }: { id: string } = await response.json();
    return id;
  }

  async function stockUp(testApp: TestApp, token: string, w: PickingWorld): Promise<void> {
    await testApp.request('/api/v1/stock/take', {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        counts: [
          { stockItemId: w.stockItems.Beans, countedQuantity: 100 },
          { stockItemId: w.stockItems.Pasta, countedQuantity: 100 },
          { stockItemId: w.stockItems.Cereal, countedQuantity: 100 },
        ],
      }),
    });
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
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ attendance }),
    });
    expect(response.status).toBe(200);
  }

  async function movePatch(
    testApp: TestApp,
    token: string,
    referralId: string,
    sessionId: string,
  ): Promise<Response> {
    return testApp.request(`/api/v1/referrals/${referralId}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  }

  it("deletes the referral's pending parcel and its lines from the session it left", async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    const parcelId = rows[0]?.id ?? '';
    expect(parcelId).not.toBe('');

    const linesBefore = await db
      .select()
      .from(parcelLines)
      .where(eq(parcelLines.parcelId, parcelId));
    expect(linesBefore.length).toBeGreaterThan(0);

    const destinationSessionId = await createSession(testApp, token, '2026-08-18');
    const moved = await movePatch(testApp, token, referral.id, destinationSessionId);
    expect(moved.status).toBe(200);

    const [storedReferral] = await db.select().from(referrals).where(eq(referrals.id, referral.id));
    expect(storedReferral?.sessionId).toBe(destinationSessionId);

    // Gone, not merely unreferenced: the parcel row itself.
    const parcelRows = await db.select().from(parcels).where(eq(parcels.referralId, referral.id));
    expect(parcelRows).toHaveLength(0);

    // Its lines went with it — the FK cascade, not a leftover to prove
    // separately.
    const lineRows = await db.select().from(parcelLines).where(eq(parcelLines.parcelId, parcelId));
    expect(lineRows).toHaveLength(0);
  });

  it('lets the destination session pick the moved household afresh, with no duplicate pick numbers on either list', async () => {
    const { testApp, token, world: w } = await world();
    // A second household stays behind, so the origin list still has a parcel
    // to compare pick numbers against.
    const staying = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const moving = await submitReferral(testApp, w, { adults: 2, children: 0 });

    const { id: originPickListId } = await generatePickList(testApp, token, w.sessionId);
    const before = await readPickList(testApp, token, originPickListId);
    expect(before.parcels).toHaveLength(2);

    const destinationSessionId = await createSession(testApp, token, '2026-08-18');
    const moved = await movePatch(testApp, token, moving.id, destinationSessionId);
    expect(moved.status).toBe(200);

    const destination = await generatePickList(testApp, token, destinationSessionId);
    expect(destination.parcelsCreated).toBe(1);

    const originAfter = await readPickList(testApp, token, originPickListId);
    expect(originAfter.parcels.map((p) => p.referralId)).toEqual([staying.id]);

    const destinationList = await readPickList(testApp, token, destination.id);
    expect(destinationList.parcels).toHaveLength(1);
    expect(destinationList.parcels[0]?.referralId).toBe(moving.id);
    // A normal pick number on the fresh list — 1, not a reservation carried
    // over from the list it left.
    expect(destinationList.parcels[0]?.pickNumber).toBe(1);

    for (const list of [originAfter.parcels, destinationList.parcels]) {
      const pickNumbers = list.map((p) => p.pickNumber);
      expect(new Set(pickNumbers).size).toBe(pickNumbers.length);
    }
  });

  it('refuses to move a referral whose parcel has already been marked attended, leaving the parcel and its stock movements untouched', async () => {
    const { testApp, token, world: w } = await world();
    await stockUp(testApp, token, w);
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    const parcelId = rows[0]?.id ?? '';

    await markAttendance(testApp, token, parcelId, 'attended');

    const ledgerBefore = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.parcelId, parcelId));
    expect(ledgerBefore.length).toBeGreaterThan(0);

    const destinationSessionId = await createSession(testApp, token, '2026-08-18');
    const moved = await movePatch(testApp, token, referral.id, destinationSessionId);
    expect(moved.status).toBe(409);

    const [storedReferral] = await db.select().from(referrals).where(eq(referrals.id, referral.id));
    expect(storedReferral?.sessionId).toBe(w.sessionId);

    const [storedParcel] = await db.select().from(parcels).where(eq(parcels.id, parcelId));
    expect(storedParcel).toBeDefined();
    expect(storedParcel?.attendance).toBe('attended');

    // Nothing orphaned: the same ledger rows, untouched by the refused move.
    const ledgerAfter = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.parcelId, parcelId));
    expect(ledgerAfter).toEqual(ledgerBefore);
  });

  it('refuses to move a referral whose parcel has already been marked no_show', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
    const { parcels: rows } = await readPickList(testApp, token, pickListId);
    const parcelId = rows[0]?.id ?? '';

    await markAttendance(testApp, token, parcelId, 'no_show');

    const destinationSessionId = await createSession(testApp, token, '2026-08-18');
    const moved = await movePatch(testApp, token, referral.id, destinationSessionId);
    expect(moved.status).toBe(409);

    const [storedReferral] = await db.select().from(referrals).where(eq(referrals.id, referral.id));
    expect(storedReferral?.sessionId).toBe(w.sessionId);

    const [storedParcel] = await db.select().from(parcels).where(eq(parcels.id, parcelId));
    expect(storedParcel).toBeDefined();
    expect(storedParcel?.attendance).toBe('no_show');
  });

  it('still moves a referral with no parcel at all — no pick list generated on its session yet', async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

    const destinationSessionId = await createSession(testApp, token, '2026-08-18');
    const moved = await movePatch(testApp, token, referral.id, destinationSessionId);
    expect(moved.status).toBe(200);

    const [storedReferral] = await db.select().from(referrals).where(eq(referrals.id, referral.id));
    expect(storedReferral?.sessionId).toBe(destinationSessionId);

    const parcelRows = await db.select().from(parcels).where(eq(parcels.referralId, referral.id));
    expect(parcelRows).toHaveLength(0);
  });

  it("records a 'moved' audit row", async () => {
    const { testApp, token, world: w } = await world();
    const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
    const destinationSessionId = await createSession(testApp, token, '2026-08-18');

    const moved = await movePatch(testApp, token, referral.id, destinationSessionId);
    expect(moved.status).toBe(200);

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, referral.id));
    const movedRow = audit.find((row) => row.action === 'moved');
    expect(movedRow).toBeDefined();
    expect(movedRow?.actorKind).toBe('user');
    expect(movedRow?.detailJson).toContain('sessionId');
  });

  describe("buildMoveReferral's own condition, run directly against the database", () => {
    /**
     * `move()`'s up-front read (`listParcelsForReferral`, exercised by the
     * tests above) always catches an attended or no_show parcel first, so the
     * conditioned `UPDATE` in `buildMoveReferral` — the one D1's lack of
     * interactive transactions actually requires — is never reached through
     * the HTTP API in any of those cases. A `NOT EXISTS` that was inverted,
     * always-true, or correlated on the wrong column would pass every test
     * above and every test in this file. These call the builder directly, the
     * same way `move()`'s own `db.batch(...)` does, to close that gap.
     */

    it("returns no row and leaves the session unchanged when the referral's only parcel is attended", async () => {
      const { testApp, token, world: w } = await world();
      await stockUp(testApp, token, w);
      const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
      const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
      const { parcels: rows } = await readPickList(testApp, token, pickListId);
      const parcelId = rows[0]?.id ?? '';
      await markAttendance(testApp, token, parcelId, 'attended');

      const destinationSessionId = await createSession(testApp, token, '2026-08-18');
      const repository = createReferralsRepository(db);
      const [movedRows] = await db.batch([
        repository.buildMoveReferral(referral.id, destinationSessionId, NOW),
      ]);
      expect(movedRows).toHaveLength(0);

      const [storedReferral] = await db
        .select()
        .from(referrals)
        .where(eq(referrals.id, referral.id));
      expect(storedReferral?.sessionId).toBe(w.sessionId);
    });

    it("returns no row and leaves the session unchanged when the referral's only parcel is no_show", async () => {
      const { testApp, token, world: w } = await world();
      const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
      const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
      const { parcels: rows } = await readPickList(testApp, token, pickListId);
      const parcelId = rows[0]?.id ?? '';
      await markAttendance(testApp, token, parcelId, 'no_show');

      const destinationSessionId = await createSession(testApp, token, '2026-08-18');
      const repository = createReferralsRepository(db);
      const [movedRows] = await db.batch([
        repository.buildMoveReferral(referral.id, destinationSessionId, NOW),
      ]);
      expect(movedRows).toHaveLength(0);

      const [storedReferral] = await db
        .select()
        .from(referrals)
        .where(eq(referrals.id, referral.id));
      expect(storedReferral?.sessionId).toBe(w.sessionId);
    });

    it("returns the moved row and changes the session when the referral's only parcel is still pending — the positive control for the two refusals above", async () => {
      const { testApp, token, world: w } = await world();
      const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });
      // A pending parcel actually exists, so a `WHERE` that matches nothing at
      // all could not pass this test the way it could pass "no parcel at all".
      await generatePickList(testApp, token, w.sessionId);

      const destinationSessionId = await createSession(testApp, token, '2026-08-18');
      const repository = createReferralsRepository(db);
      const [movedRows] = await db.batch([
        repository.buildMoveReferral(referral.id, destinationSessionId, NOW),
      ]);
      expect(movedRows).toHaveLength(1);

      const [storedReferral] = await db
        .select()
        .from(referrals)
        .where(eq(referrals.id, referral.id));
      expect(storedReferral?.sessionId).toBe(destinationSessionId);
    });

    it('returns the moved row and changes the session when the referral has no parcel at all', async () => {
      const { testApp, token, world: w } = await world();
      const referral = await submitReferral(testApp, w, { adults: 1, children: 0 });

      const destinationSessionId = await createSession(testApp, token, '2026-08-18');
      const repository = createReferralsRepository(db);
      const [movedRows] = await db.batch([
        repository.buildMoveReferral(referral.id, destinationSessionId, NOW),
      ]);
      expect(movedRows).toHaveLength(1);

      const [storedReferral] = await db
        .select()
        .from(referrals)
        .where(eq(referrals.id, referral.id));
      expect(storedReferral?.sessionId).toBe(destinationSessionId);
    });

    it("only counts the referral's own parcels — another referral's attended parcel does not block this one from moving", async () => {
      const { testApp, token, world: w } = await world();
      await stockUp(testApp, token, w);
      const blocked = await submitReferral(testApp, w, { adults: 1, children: 0 });
      const moving = await submitReferral(testApp, w, { adults: 1, children: 0 });
      const { id: pickListId } = await generatePickList(testApp, token, w.sessionId);
      const { parcels: rows } = await readPickList(testApp, token, pickListId);
      const blockedParcel = rows.find((p) => p.referralId === blocked.id);
      expect(blockedParcel).toBeDefined();
      await markAttendance(testApp, token, blockedParcel?.id ?? '', 'attended');

      const destinationSessionId = await createSession(testApp, token, '2026-08-18');
      const repository = createReferralsRepository(db);
      const [movedRows] = await db.batch([
        repository.buildMoveReferral(moving.id, destinationSessionId, NOW),
      ]);
      expect(movedRows).toHaveLength(1);

      const [storedReferral] = await db.select().from(referrals).where(eq(referrals.id, moving.id));
      expect(storedReferral?.sessionId).toBe(destinationSessionId);

      // The other referral's parcel — and its outcome — are untouched.
      const [storedBlocked] = await db.select().from(referrals).where(eq(referrals.id, blocked.id));
      expect(storedBlocked?.sessionId).toBe(w.sessionId);
    });
  });
});
