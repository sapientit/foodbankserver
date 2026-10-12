import { env } from 'cloudflare:workers';
import { eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createLogger } from '../src/core/log.ts';
import { createDatabase } from '../src/db/client.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { smsMessages } from '../src/db/schema/sms.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { purgeExpiredReferrals } from '../src/modules/jobs/purge-referrals.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  generatePickList,
  setUpPickingWorld,
  submitReferral,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

/**
 * `INITIAL_SPEC1.txt`, `#Forgetting a referral`: fifteen months after it was
 * made, the food bank **deletes a referral outright** — not anonymised, not
 * kept in a reduced form. Its parcel goes with it, pick-list information and
 * all. The session's own figures — the pick list, the stock that moved — stand.
 */

const db = createDatabase(env.DB);
const NOW = '2026-08-04T09:00:00.000Z';
const LONG_AGO = '2020-01-01T00:00:00.000Z';

const purge = (retentionDays: number | undefined) =>
  purgeExpiredReferrals({
    db,
    clock: fixedClock(NOW),
    logger: createLogger('silent'),
    retentionDays,
  });

interface Scene {
  readonly testApp: TestApp;
  readonly token: string;
  readonly world: PickingWorld;
  readonly oldId: string;
  readonly recentId: string;
  readonly pickListId: string;
}

/**
 * Two referrals on one session, a pick list giving each a parcel with lines,
 * a text and a stock movement for each — then one of them aged past
 * retention. Everything the purge must remove, beside everything it must not.
 */
async function scene(): Promise<Scene> {
  const testApp = buildTestApp({ clock: fixedClock(NOW) });
  const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const world = await setUpPickingWorld(testApp, token);

  const old = await submitReferral(testApp, world, {}, { clientIp: '192.0.2.1' });
  const recent = await submitReferral(testApp, world, {}, { clientIp: '192.0.2.2' });
  expect(old.status, JSON.stringify(old.body)).toBe(201);
  expect(recent.status, JSON.stringify(recent.body)).toBe(201);

  const pickList = await generatePickList(testApp, token, world.sessionId);
  expect(pickList.parcelsCreated).toBe(2);

  for (const id of [old.id, recent.id]) {
    const [parcel] = await db.select().from(parcels).where(eq(parcels.referralId, id));
    await db.insert(smsMessages).values({
      id: `sms-${id}`,
      referralId: id,
      sessionId: world.sessionId,
      kind: 'household_reply',
      phone: '+447700900123',
      body: 'Running late',
      occurredAt: NOW,
      recipientRole: 'referee',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(stockLedger).values({
      id: `ledger-${id}`,
      stockItemId: world.stockItems.Beans,
      movementType: 'parcel_issued',
      quantityDelta: -2,
      parcelId: parcel?.id ?? null,
      sessionId: world.sessionId,
      occurredAt: NOW,
      actorUserId: null,
      createdAt: NOW,
    });
  }

  await db.update(referrals).set({ referredAt: LONG_AGO }).where(eq(referrals.id, old.id));

  return { testApp, token, world, oldId: old.id, recentId: recent.id, pickListId: pickList.id };
}

beforeEach(async () => {
  await db.delete(smsMessages);
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

describe('forgetting a referral after the retention period', () => {
  it('does nothing at all until a retention period is set', async () => {
    const { oldId } = await scene();

    const result = await purge(undefined);

    expect(result.purged).toBe(0);
    expect(await db.select().from(referrals).where(eq(referrals.id, oldId))).toHaveLength(1);
  });

  it('deletes the referral outright, with its parcel, parcel lines, texts and audit trail', async () => {
    const { testApp, token, oldId } = await scene();
    const [oldParcel] = await db.select().from(parcels).where(eq(parcels.referralId, oldId));
    expect(oldParcel).toBeDefined();
    const oldParcelId = oldParcel?.id ?? '';
    // Positive controls: each of these exists before the purge, so the
    // assertions after it cannot pass on an empty table.
    expect(
      await db.select().from(parcelLines).where(eq(parcelLines.parcelId, oldParcelId)),
    ).not.toHaveLength(0);
    expect(
      await db.select().from(auditEvents).where(eq(auditEvents.entityId, oldId)),
    ).not.toHaveLength(0);

    const result = await purge(456);

    expect(result.purged).toBe(1);
    expect(await db.select().from(referrals).where(eq(referrals.id, oldId))).toHaveLength(0);
    expect(await db.select().from(parcels).where(eq(parcels.id, oldParcelId))).toHaveLength(0);
    expect(
      await db.select().from(parcelLines).where(eq(parcelLines.parcelId, oldParcelId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(smsMessages).where(eq(smsMessages.referralId, oldId)),
    ).toHaveLength(0);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.entityId, oldId))).toHaveLength(
      0,
    );

    const response = await testApp.request(`/api/v1/referrals/${oldId}`, {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(404);
  });

  it("leaves the session's own figures and every referral still inside the period", async () => {
    const { world, oldId, recentId, pickListId } = await scene();

    await purge(456);

    expect(await db.select().from(sessions).where(eq(sessions.id, world.sessionId))).toHaveLength(
      1,
    );
    expect(await db.select().from(pickLists).where(eq(pickLists.id, pickListId))).toHaveLength(1);
    // What stock moved stands, whether or not the parcel it moved for still exists.
    expect(
      await db
        .select()
        .from(stockLedger)
        .where(inArray(stockLedger.id, [`ledger-${oldId}`, `ledger-${recentId}`])),
    ).toHaveLength(2);

    expect(await db.select().from(referrals).where(eq(referrals.id, recentId))).toHaveLength(1);
    expect(await db.select().from(parcels).where(eq(parcels.referralId, recentId))).toHaveLength(1);
    expect(
      await db.select().from(smsMessages).where(eq(smsMessages.referralId, recentId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(auditEvents).where(eq(auditEvents.entityId, recentId)),
    ).not.toHaveLength(0);
  });

  it('deletes every expired referral in one run, however many there are', async () => {
    const testApp = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: token } = await devLogin(testApp, { email: 'admin@foodbank.org' });
    const world = await setUpPickingWorld(testApp, token, { capacity: 80 });
    // More than the free plan's fifty queries per invocation: a purge that
    // spent a statement per referral could not finish this in one night.
    for (let i = 0; i < 60; i += 1) {
      const submitted = await submitReferral(
        testApp,
        world,
        {},
        { clientIp: `198.51.100.${String(i)}` },
      );
      expect(submitted.status).toBe(201);
    }
    await db.update(referrals).set({ referredAt: LONG_AGO });

    // Counts every statement the purge prepares against D1.
    let statements = 0;
    const counted = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (query: string) => {
            statements += 1;
            return target.prepare(query);
          };
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args);
          return result;
        };
      },
    });

    const result = await purgeExpiredReferrals({
      db: createDatabase(counted),
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
      retentionDays: 456,
    });

    expect(result.purged).toBe(60);
    expect(await db.select().from(referrals)).toHaveLength(0);
    // A fixed handful, not one per referral.
    expect(statements).toBeLessThanOrEqual(10);
  });

  it('is idempotent — a second run deletes nothing further', async () => {
    await scene();

    expect((await purge(456)).purged).toBe(1);
    expect((await purge(456)).purged).toBe(0);
  });
});
