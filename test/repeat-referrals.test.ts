import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createLogger } from '../src/core/log.ts';
import { REPEAT_REFERRAL_LIST_LIMIT } from '../src/config/constants.ts';
import { createDatabase } from '../src/db/client.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { parcelLines, parcels, pickLists } from '../src/db/schema/pick-lists.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { purgeReferralPii } from '../src/modules/jobs/purge-pii.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  setUpReferralWorld,
  submitReferral,
  UNKNOWN_REFERRER,
  type ReferralWorld,
} from './helpers/referral-fixtures.ts';
import {
  generatePickList,
  setUpPickingWorld,
  type PickingWorld,
} from './helpers/picking-fixtures.ts';

const db = createDatabase(env.DB);

/**
 * A referral submission always requires a date of birth (see
 * `referrals.schema.ts`) and the session date in `setUpReferralWorld` is
 * 2026-08-11, so this sits comfortably before it.
 */
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

/**
 * Referral submission is rate limited per client address, and most tests here
 * seed several referrals in one test. A counter rather than a shared or random
 * address: two tests, or two referrals in the same test, colliding on one
 * would fail for a reason that has nothing to do with matching.
 */
let clientIpCounter = 0;
function nextClientIp(): string {
  clientIpCounter += 1;
  return `203.0.113.${String(clientIpCounter)}`;
}

async function referralWorld(
  now: string,
): Promise<{ testApp: TestApp; token: string; world: ReferralWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(now) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const world = await setUpReferralWorld(testApp, accessToken);
  return { testApp, token: accessToken, world };
}

async function pickingWorld(
  now: string,
): Promise<{ testApp: TestApp; token: string; world: PickingWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(now) });
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

async function createSession(
  testApp: TestApp,
  token: string,
  sessionDate: string,
  capacity = 25,
): Promise<string> {
  const response = await testApp.request('/api/v1/sessions', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({
      sessionDate,
      startTime: '10:00',
      durationMinutes: 120,
      location: 'Church Hall',
      capacity,
    }),
  });
  const { id }: { id: string } = await response.json();
  return id;
}

/** The same referral world, pointed at a different session. */
function inSession(world: ReferralWorld, sessionId: string): ReferralWorld {
  return { ...world, sessionId };
}

interface RepeatReferralSummaryBody {
  readonly count: number;
  readonly mostRecentSessionDate: string | null;
}

interface ReferralDetailBody {
  readonly id: string;
  readonly status: string;
  readonly repeatReferrals?: RepeatReferralSummaryBody;
}

async function getReferral(
  testApp: TestApp,
  token: string,
  id: string,
): Promise<{ status: number; body: ReferralDetailBody & Record<string, unknown> }> {
  const response = await testApp.request(`/api/v1/referrals/${id}`, {
    headers: authHeaders(token),
  });
  const body: ReferralDetailBody & Record<string, unknown> = await response.json();
  return { status: response.status, body };
}

interface RepeatReferralMatchBody {
  readonly referralId: string;
  readonly sessionId: string;
  readonly sessionDate: string;
  readonly outcome: string;
  readonly matchedOn: string[];
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereeDateOfBirth: string | null;
  readonly refereeAddress: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
}

interface RepeatReferralListBody extends RepeatReferralSummaryBody {
  readonly matches: RepeatReferralMatchBody[];
}

async function getRepeatReferrals(
  testApp: TestApp,
  token: string,
  id: string,
  query = '',
): Promise<{ status: number; body: RepeatReferralListBody }> {
  const response = await testApp.request(`/api/v1/referrals/${id}/repeat-referrals${query}`, {
    headers: authHeaders(token),
  });
  const body: RepeatReferralListBody = await response.json();
  return { status: response.status, body };
}

/**
 * Picks the session, finds the parcel for one referral on it, reviews it and
 * records its attendance. Every household on the session is picked together —
 * a pick list is per session, not per household — so this reads the list back
 * to find the parcel that belongs to the referral under test.
 */
async function markAttendance(
  testApp: TestApp,
  token: string,
  sessionId: string,
  referralId: string,
  attendance: 'attended' | 'no_show',
): Promise<void> {
  const { id: pickListId } = await generatePickList(testApp, token, sessionId);
  const response = await testApp.request(`/api/v1/pick-lists/${pickListId}`, {
    headers: authHeaders(token),
  });
  const body: { parcels: { id: string; referralId: string }[] } = await response.json();
  const parcel = body.parcels.find((candidate) => candidate.referralId === referralId);
  if (parcel === undefined) {
    throw new Error(`No parcel generated for referral ${referralId}`);
  }

  await testApp.request(`/api/v1/parcels/${parcel.id}/review`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  await testApp.request(`/api/v1/parcels/${parcel.id}/attendance`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ attendance }),
  });
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

describe('repeat-referral detection at review', () => {
  it('reports the other referral as a match when a household is booked into two sessions in the same week — the case this feature exists for', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    // w.sessionId is 2026-08-11 (Tuesday); this one is the Thursday of the
    // same week. Neither referral has been picked and neither has a parcel.
    const secondSessionId = await createSession(testApp, token, '2026-08-13');

    const first = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );
    const second = await submitReferral(
      testApp,
      inSession(w, secondSessionId),
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const firstDetail = await getReferral(testApp, token, first.id);
    expect(firstDetail.body.repeatReferrals).toEqual({
      count: 1,
      mostRecentSessionDate: '2026-08-13',
    });

    const secondDetail = await getReferral(testApp, token, second.id);
    expect(secondDetail.body.repeatReferrals).toEqual({
      count: 1,
      mostRecentSessionDate: '2026-08-11',
    });

    // If this passed for the wrong reason the feature would be pointless, so
    // the match's outcome is asserted too: nothing has been picked yet.
    const list = await getRepeatReferrals(testApp, token, second.id);
    expect(list.body.matches).toHaveLength(1);
    expect(list.body.matches[0]?.referralId).toBe(first.id);
    expect(list.body.matches[0]?.outcome).toBe('booked');
  });

  it('does not count a cancelled referral', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const other = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );
    const self = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );

    // Positive control: before cancelling, the pair matches.
    expect((await getReferral(testApp, token, self.id)).body.repeatReferrals?.count).toBe(1);

    await testApp.request(`/api/v1/referrals/${other.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const detail = await getReferral(testApp, token, self.id);
    expect(detail.body.repeatReferrals).toEqual({ count: 0, mostRecentSessionDate: null });
  });

  it('does not count a rejected referral', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const rejected = await submitReferral(
      testApp,
      w,
      { ...UNKNOWN_REFERRER, refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );
    expect(rejected.referralStatus).toBe('pending_review');
    const self = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );

    // Positive control: a pending referral still counts, because the count is
    // of every referral not turned away — see `INITIAL_SPEC1.txt`.
    expect((await getReferral(testApp, token, self.id)).body.repeatReferrals?.count).toBe(1);

    await testApp.request(`/api/v1/referrals/${rejected.id}/reject`, {
      method: 'POST',
      headers: authHeaders(token),
    });

    const detail = await getReferral(testApp, token, self.id);
    expect(detail.body.repeatReferrals).toEqual({ count: 0, mostRecentSessionDate: null });
  });

  describe('outcome', () => {
    it('counts a household who did not turn up, reporting outcome no_show', async () => {
      const { testApp, token, world: w } = await pickingWorld(NOW);
      const noShow = await submitReferral(
        testApp,
        w,
        { refereePostcode: 'GU9 7ZZ' },
        { clientIp: nextClientIp() },
      );
      const self = await submitReferral(
        testApp,
        w,
        { refereePostcode: 'GU9 7ZZ' },
        { clientIp: nextClientIp() },
      );

      await markAttendance(testApp, token, w.sessionId, noShow.id, 'no_show');

      const list = await getRepeatReferrals(testApp, token, self.id);
      expect(list.body.matches).toHaveLength(1);
      expect(list.body.matches[0]?.outcome).toBe('no_show');
    });

    it('counts a household who was fed, reporting outcome attended', async () => {
      const { testApp, token, world: w } = await pickingWorld(NOW);
      const attended = await submitReferral(
        testApp,
        w,
        { refereePostcode: 'GU9 7ZZ' },
        { clientIp: nextClientIp() },
      );
      const self = await submitReferral(
        testApp,
        w,
        { refereePostcode: 'GU9 7ZZ' },
        { clientIp: nextClientIp() },
      );

      await markAttendance(testApp, token, w.sessionId, attended.id, 'attended');

      const list = await getRepeatReferrals(testApp, token, self.id);
      expect(list.body.matches).toHaveLength(1);
      expect(list.body.matches[0]?.outcome).toBe('attended');
    });
  });

  describe('which of the three fields matched', () => {
    it('matches on date of birth alone, with postcode and phone deliberately different', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1970-06-15',
          refereePostcode: 'GU1 4AA',
          refereePhone: '07700 900111',
        },
        { clientIp: nextClientIp() },
      );
      const self = await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1970-06-15',
          refereePostcode: 'GU2 9ZZ',
          refereePhone: '07700 900222',
        },
        { clientIp: nextClientIp() },
      );

      const list = await getRepeatReferrals(testApp, token, self.id);
      expect(list.body.matches).toHaveLength(1);
      expect(list.body.matches[0]?.matchedOn).toEqual(['date_of_birth']);
    });

    it('matches on postcode alone, with date of birth and phone deliberately different', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1970-06-15',
          refereePostcode: 'GU1 4AA',
          refereePhone: '07700 900111',
        },
        { clientIp: nextClientIp() },
      );
      const self = await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1971-07-16',
          refereePostcode: 'GU1 4AA',
          refereePhone: '07700 900222',
        },
        { clientIp: nextClientIp() },
      );

      const list = await getRepeatReferrals(testApp, token, self.id);
      expect(list.body.matches).toHaveLength(1);
      expect(list.body.matches[0]?.matchedOn).toEqual(['postcode']);
    });

    it('matches on phone alone, with date of birth and postcode deliberately different', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1970-06-15',
          refereePostcode: 'GU1 4AA',
          refereePhone: '07700 900111',
        },
        { clientIp: nextClientIp() },
      );
      const self = await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1971-07-16',
          refereePostcode: 'GU2 9ZZ',
          refereePhone: '07700 900111',
        },
        { clientIp: nextClientIp() },
      );

      const list = await getRepeatReferrals(testApp, token, self.id);
      expect(list.body.matches).toHaveLength(1);
      expect(list.body.matches[0]?.matchedOn).toEqual(['phone']);
    });

    it('reports all three kinds, in order, when date of birth, postcode and phone all agree', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      const shared = {
        refereeDateOfBirth: '1970-06-15',
        refereePostcode: 'GU1 4AA',
        refereePhone: '07700 900111',
      };
      await submitReferral(testApp, w, shared, { clientIp: nextClientIp() });
      const self = await submitReferral(testApp, w, shared, { clientIp: nextClientIp() });

      const list = await getRepeatReferrals(testApp, token, self.id);
      expect(list.body.matches[0]?.matchedOn).toEqual(['date_of_birth', 'postcode', 'phone']);
    });

    it('matches postcodes typed differently — lower case and no space, against upper case and no space', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1970-01-01',
          refereePostcode: 'gu1 4aa',
          refereePhone: '07700 900111',
        },
        { clientIp: nextClientIp() },
      );
      const self = await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1971-02-02',
          refereePostcode: 'GU14AA',
          refereePhone: '07700 900222',
        },
        { clientIp: nextClientIp() },
      );

      const list = await getRepeatReferrals(testApp, token, self.id);
      expect(list.body.matches[0]?.matchedOn).toEqual(['postcode']);
    });

    it('matches phone numbers written differently — with a space and a leading 0, against +44 and a space', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1970-01-01',
          refereePostcode: 'GU1 4AA',
          refereePhone: '07700 900123',
        },
        { clientIp: nextClientIp() },
      );
      const self = await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1971-02-02',
          refereePostcode: 'GU2 9ZZ',
          refereePhone: '+44 7700 900123',
        },
        { clientIp: nextClientIp() },
      );

      const list = await getRepeatReferrals(testApp, token, self.id);
      expect(list.body.matches[0]?.matchedOn).toEqual(['phone']);
    });

    it('does not match two referrals with the same unparseable postcode', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1970-01-01',
          refereePostcode: 'NOTVALID',
          refereePhone: '07700 900111',
        },
        { clientIp: nextClientIp() },
      );
      const self = await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1971-02-02',
          refereePostcode: 'NOTVALID',
          refereePhone: '07700 900222',
        },
        { clientIp: nextClientIp() },
      );

      const detail = await getReferral(testApp, token, self.id);
      expect(detail.body.repeatReferrals).toEqual({ count: 0, mostRecentSessionDate: null });
    });

    it('does not match two referrals with the same unparseable phone number', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1970-01-01',
          refereePostcode: 'GU1 4AA',
          refereePhone: '123456789012345',
        },
        { clientIp: nextClientIp() },
      );
      const self = await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1971-02-02',
          refereePostcode: 'GU2 9ZZ',
          refereePhone: '123456789012345',
        },
        { clientIp: nextClientIp() },
      );

      const detail = await getReferral(testApp, token, self.id);
      expect(detail.body.repeatReferrals).toEqual({ count: 0, mostRecentSessionDate: null });
    });

    it('does not match two referrals that both have no phone number', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      await submitReferral(
        testApp,
        w,
        { refereeDateOfBirth: '1970-01-01', refereePostcode: 'GU1 4AA', refereePhone: undefined },
        { clientIp: nextClientIp() },
      );
      const self = await submitReferral(
        testApp,
        w,
        { refereeDateOfBirth: '1971-02-02', refereePostcode: 'GU2 9ZZ', refereePhone: undefined },
        { clientIp: nextClientIp() },
      );

      const detail = await getReferral(testApp, token, self.id);
      expect(detail.body.repeatReferrals).toEqual({ count: 0, mostRecentSessionDate: null });
    });
  });

  it('is never its own match', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const detail = await getReferral(testApp, token, id);
    expect(detail.body.repeatReferrals).toEqual({ count: 0, mostRecentSessionDate: null });

    const list = await getRepeatReferrals(testApp, token, id);
    expect(list.body).toEqual({ count: 0, mostRecentSessionDate: null, matches: [] });
  });

  it('reports zero with an empty list when a referral has nothing matchable at all', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    // No dob, an unparseable postcode and no phone. A live submission always
    // requires a date of birth, so this state is only real after a purge, or
    // for a referral entered with details the matching rule cannot place —
    // constructed directly rather than by fighting the schema.
    await db
      .update(referrals)
      .set({
        refereeDateOfBirth: null,
        refereePostcode: 'not a postcode',
        refereePostcodeNormalised: null,
        refereePhone: null,
        refereePhoneNormalised: null,
      })
      .where(eq(referrals.id, id));

    const detail = await getReferral(testApp, token, id);
    expect(detail.body.repeatReferrals).toEqual({ count: 0, mostRecentSessionDate: null });

    const list = await getRepeatReferrals(testApp, token, id);
    expect(list.body).toEqual({ count: 0, mostRecentSessionDate: null, matches: [] });
  });

  it('does not match a referral once it has been purged', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const other = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );
    const self = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );

    // Positive control: before the purge, the pair matches — both referrals
    // are on `w.sessionId`, 2026-08-11.
    expect((await getReferral(testApp, token, self.id)).body.repeatReferrals).toEqual({
      count: 1,
      mostRecentSessionDate: '2026-08-11',
    });

    // Age the other referral past retention and run the real purge job — the
    // same one the nightly cron calls — rather than hand-editing the columns.
    await db
      .update(referrals)
      .set({ referredAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(referrals.id, other.id));
    await purgeReferralPii({
      db,
      clock: fixedClock(NOW),
      logger: createLogger('silent'),
      retentionDays: 365,
    });

    const after = await getReferral(testApp, token, self.id);
    expect(after.body.repeatReferrals).toEqual({ count: 0, mostRecentSessionDate: null });
  });

  describe('the twelve-month window, on referredAt', () => {
    // London's date at this instant is 2026-08-21, one day ahead of the UTC
    // date 2026-08-20 — Britain is on BST (UTC+1) in August, so 23:30 UTC is
    // 00:30 the next day in London. That mismatch is deliberate: it is the
    // case that catches a cutoff computed on the wrong clock. See
    // `.claude/rules/time.md`.
    const NOW_STRADDLING_BST = '2026-08-20T23:30:00.000Z';

    // Twelve months (365 days — REPEAT_REFERRAL_LOOKBACK_DAYS) back from the
    // London date above, 2026-08-21, is 2025-08-21 (no leap day falls between
    // them). London is on BST in August 2025 too, so the cutoff instant —
    // 2025-08-21 at 00:30 London — is 2025-08-20T23:30:00.000Z in UTC. Both
    // instants below are computed by hand, independently of the code under
    // test.
    const JUST_INSIDE = '2025-08-20T23:30:00.000Z'; // exactly at the cutoff: inclusive
    const JUST_OUTSIDE = '2025-08-20T23:29:00.000Z'; // one minute earlier: excluded

    it('includes a referral referred exactly at the cutoff and excludes one referred a minute earlier', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW_STRADDLING_BST);

      const inside = await submitReferral(
        testApp,
        w,
        { refereePostcode: 'GU9 7ZZ' },
        { clientIp: nextClientIp() },
      );
      const outside = await submitReferral(
        testApp,
        w,
        { refereePostcode: 'GU9 7ZZ' },
        { clientIp: nextClientIp() },
      );
      const self = await submitReferral(
        testApp,
        w,
        { refereePostcode: 'GU9 7ZZ' },
        { clientIp: nextClientIp() },
      );

      await db
        .update(referrals)
        .set({ referredAt: JUST_INSIDE })
        .where(eq(referrals.id, inside.id));
      await db
        .update(referrals)
        .set({ referredAt: JUST_OUTSIDE })
        .where(eq(referrals.id, outside.id));

      const list = await getRepeatReferrals(testApp, token, self.id);
      expect(list.body.matches.map((match) => match.referralId)).toEqual([inside.id]);
    });
  });

  it('reports the greatest session date among matches, which may be in the future — not the latest referredAt', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const earlySession = await createSession(testApp, token, '2026-08-05');
    const futureSession = await createSession(testApp, token, '2026-12-25');

    // Referred later but booked into the earlier session.
    const referredLaterBookedEarlier = await submitReferral(
      testApp,
      inSession(w, earlySession),
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );
    // Referred first but booked into the far-future session.
    const referredFirstBookedLater = await submitReferral(
      testApp,
      inSession(w, futureSession),
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );

    // Force the referredAt ordering to be the opposite of the session-date
    // ordering, so picking or sorting by referredAt instead of session date
    // would show up here.
    await db
      .update(referrals)
      .set({ referredAt: '2026-08-01T09:00:00.000Z' })
      .where(eq(referrals.id, referredFirstBookedLater.id));
    await db
      .update(referrals)
      .set({ referredAt: '2026-08-03T09:00:00.000Z' })
      .where(eq(referrals.id, referredLaterBookedEarlier.id));

    const self = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );

    const detail = await getReferral(testApp, token, self.id);
    expect(detail.body.repeatReferrals).toEqual({ count: 2, mostRecentSessionDate: '2026-12-25' });
  });

  it('orders matches by session date, most recent first', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const early = await createSession(testApp, token, '2026-08-06');
    const latest = await createSession(testApp, token, '2026-08-20');
    const middle = await createSession(testApp, token, '2026-08-13');

    const a = await submitReferral(
      testApp,
      inSession(w, early),
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );
    const b = await submitReferral(
      testApp,
      inSession(w, latest),
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );
    const c = await submitReferral(
      testApp,
      inSession(w, middle),
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );
    const self = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU9 7ZZ' },
      { clientIp: nextClientIp() },
    );

    const list = await getRepeatReferrals(testApp, token, self.id);
    expect(list.body.matches.map((match) => match.referralId)).toEqual([b.id, c.id, a.id]);
    expect(list.body.matches.map((match) => match.sessionDate)).toEqual([
      '2026-08-20',
      '2026-08-13',
      '2026-08-06',
    ]);
  });

  describe('role separation', () => {
    it('gives an administrator the summary and withholds the field entirely from a team lead', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

      const adminDetail = await getReferral(testApp, token, id);
      expect(adminDetail.body.repeatReferrals).toEqual({ count: 0, mostRecentSessionDate: null });

      const lead = buildTestApp({ clock: fixedClock(NOW) });
      const { accessToken } = await devLogin(lead, {
        email: 'lead@foodbank.org',
        role: 'team_lead',
      });
      const leadResponse = await lead.request(`/api/v1/referrals/${id}`, {
        headers: authHeaders(accessToken),
      });
      const leadBody: Record<string, unknown> = await leadResponse.json();

      expect(leadResponse.status).toBe(200);
      // The key must be entirely absent, not present and null or undefined —
      // this checks the parsed body has no such property at all.
      expect(Object.prototype.hasOwnProperty.call(leadBody, 'repeatReferrals')).toBe(false);
    });

    it('refuses a team lead and a fuel administrator the full repeat-referral list; an admin gets it', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

      const lead = buildTestApp({ clock: fixedClock(NOW) });
      const { accessToken: leadToken } = await devLogin(lead, {
        email: 'lead@foodbank.org',
        role: 'team_lead',
      });
      const leadResponse = await lead.request(`/api/v1/referrals/${id}/repeat-referrals`, {
        headers: authHeaders(leadToken),
      });
      expect(leadResponse.status).toBe(403);

      const fuel = buildTestApp({ clock: fixedClock(NOW) });
      const { accessToken: fuelToken } = await devLogin(fuel, {
        email: 'fuel@foodbank.org',
        role: 'fuel_admin',
      });
      const fuelResponse = await fuel.request(`/api/v1/referrals/${id}/repeat-referrals`, {
        headers: authHeaders(fuelToken),
      });
      expect(fuelResponse.status).toBe(403);

      // The positive control: an admin is allowed the same route.
      const adminResponse = await testApp.request(`/api/v1/referrals/${id}/repeat-referrals`, {
        headers: authHeaders(token),
      });
      expect(adminResponse.status).toBe(200);
    });
  });

  it('carries exactly the documented fields on each match, and nothing else — the PII allowlist', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const shared = { refereePostcode: 'GU9 7ZZ' };
    await submitReferral(testApp, w, shared, { clientIp: nextClientIp() });
    const self = await submitReferral(testApp, w, shared, { clientIp: nextClientIp() });

    const list = await getRepeatReferrals(testApp, token, self.id);
    const row = list.body.matches[0];
    expect(row).toBeDefined();

    expect(Object.keys(row as object).sort()).toEqual(
      [
        'referralId',
        'sessionId',
        'sessionDate',
        'outcome',
        'matchedOn',
        'refereeFirstName',
        'refereeSurname',
        'refereeDateOfBirth',
        'refereeAddress',
        'refereePostcode',
        'refereePhone',
      ].sort(),
    );

    const text = JSON.stringify(list.body);
    for (const absent of [
      'reasonId',
      'answers',
      'reviewComment',
      '"status"',
      'postcodeNormalised',
      'phoneNormalised',
      'refereePostcodeNormalised',
      'refereePhoneNormalised',
    ]) {
      expect(text).not.toContain(absent);
    }
  });

  describe("the spec's own example: a correction changes what is visible", () => {
    it('makes a previously invisible household appear once a mistyped postcode is corrected', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      // Date of birth and phone deliberately differ too, so only the postcode
      // correction can be what makes the pair start matching.
      await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1950-05-05',
          refereePostcode: 'GU9 7ZZ',
          refereePhone: '07700 900001',
        },
        { clientIp: nextClientIp() },
      );
      const mistyped = await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1951-06-06',
          refereePostcode: 'GU9 7ZX',
          refereePhone: '07700 900002',
        },
        { clientIp: nextClientIp() },
      );

      const before = await getReferral(testApp, token, mistyped.id);
      expect(before.body.repeatReferrals).toEqual({ count: 0, mostRecentSessionDate: null });

      const patched = await testApp.request(`/api/v1/referrals/${mistyped.id}`, {
        method: 'PATCH',
        headers: json(token),
        body: JSON.stringify({ refereePostcode: 'GU9 7ZZ' }),
      });
      expect(patched.status).toBe(200);

      const after = await getReferral(testApp, token, mistyped.id);
      expect(after.body.repeatReferrals).toEqual({ count: 1, mostRecentSessionDate: '2026-08-11' });
    });

    it('makes a previously invisible household appear once a mistyped phone number is corrected', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1960-01-01',
          refereePostcode: 'GU1 1AA',
          refereePhone: '07700 900555',
        },
        { clientIp: nextClientIp() },
      );
      const mistyped = await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1961-02-02',
          refereePostcode: 'GU2 2BB',
          refereePhone: '07700 900556',
        },
        { clientIp: nextClientIp() },
      );

      const before = await getReferral(testApp, token, mistyped.id);
      expect(before.body.repeatReferrals).toEqual({ count: 0, mostRecentSessionDate: null });

      const patched = await testApp.request(`/api/v1/referrals/${mistyped.id}`, {
        method: 'PATCH',
        headers: json(token),
        body: JSON.stringify({ refereePhone: '07700 900555' }),
      });
      expect(patched.status).toBe(200);

      const after = await getReferral(testApp, token, mistyped.id);
      expect(after.body.repeatReferrals).toEqual({ count: 1, mostRecentSessionDate: '2026-08-11' });
    });

    it('stops matching on phone once the phone number is corrected to null', async () => {
      const { testApp, token, world: w } = await referralWorld(NOW);
      await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1962-03-03',
          refereePostcode: 'GU3 3CC',
          refereePhone: '07700 900777',
        },
        { clientIp: nextClientIp() },
      );
      const self = await submitReferral(
        testApp,
        w,
        {
          refereeDateOfBirth: '1963-04-04',
          refereePostcode: 'GU4 4DD',
          refereePhone: '07700 900777',
        },
        { clientIp: nextClientIp() },
      );

      // Positive control: matched on phone alone before the correction.
      const before = await getReferral(testApp, token, self.id);
      expect(before.body.repeatReferrals).toEqual({
        count: 1,
        mostRecentSessionDate: '2026-08-11',
      });

      const patched = await testApp.request(`/api/v1/referrals/${self.id}`, {
        method: 'PATCH',
        headers: json(token),
        body: JSON.stringify({ refereePhone: null }),
      });
      expect(patched.status).toBe(200);

      const after = await getReferral(testApp, token, self.id);
      expect(after.body.repeatReferrals).toEqual({ count: 0, mostRecentSessionDate: null });
    });
  });
});

/**
 * `INITIAL_SPEC1.txt`, `#Reviewing a referral`: "The list stops at fifty, the
 * fifty most recent. ... The count is not capped and still says how many
 * there really are, so a list of fifty against a count of three hundred says
 * plainly that fifty is not all of them." Settled with Pete 2026-08-07 (Q28).
 *
 * Seeded directly through Drizzle rather than through fifty-plus live
 * submissions — the referral limiter is 5/60s, and matching only needs the
 * settled columns to be right, not a real submission. These rows carry a real
 * matchable postcode and its normalised form is set by hand, since they never
 * pass through the service that would otherwise compute it.
 */
describe('the fifty-match cap on the list, and the uncapped count beside it', () => {
  /** A referral that matches on postcode alone, inserted directly. */
  async function seedMatchingReferral(
    world: ReferralWorld,
    sessionId: string,
    postcode: string,
    postcodeNormalised: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(referrals).values({
      id,
      sessionId,
      status: 'active',
      referredAt: NOW,
      cancelledAt: null,
      cancelledReason: null,
      reviewComment: null,
      reviewedByUserId: null,
      referrerOrganisation: 'Cap Test Org',
      authorisedReferrerId: null,
      adults: 1,
      children: 0,
      isDelivery: 0,
      reasonId: world.reasonId,
      needsFuelHelp: 0,
      referrerName: null,
      referrerEmail: null,
      referrerPhone: null,
      refereeFirstName: null,
      refereeSurname: null,
      refereeDateOfBirth: null,
      refereeAddress: null,
      refereePostcode: postcode,
      refereePhone: null,
      refereePostcodeNormalised: postcodeNormalised,
      refereePhoneNormalised: null,
      answersJson: null,
      piiPurgedAt: null,
      createdByUserId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return id;
  }

  it('caps the list at fifty but reports the true, larger count — the two numbers must differ', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const bulkCount = REPEAT_REFERRAL_LIST_LIMIT + 5; // comfortably over the cap
    for (let i = 0; i < bulkCount; i += 1) {
      await seedMatchingReferral(w, w.sessionId, 'GU9 7ZZ', 'GU97ZZ');
    }
    const self = await seedMatchingReferral(w, w.sessionId, 'GU9 7ZZ', 'GU97ZZ');

    const list = await getRepeatReferrals(testApp, token, self);

    // The concrete value, not just the constant, so a change to
    // `REPEAT_REFERRAL_LIST_LIMIT` is a visible change to this test.
    expect(list.body.matches).toHaveLength(50);
    expect(list.body.count).toBe(bulkCount);
    // A test that only checked the length of `matches` would still pass if
    // `count` were capped too — that divergence is the whole point of Q28.
    expect(list.body.count).toBeGreaterThan(list.body.matches.length);
  });

  it('keeps the fifty most recent by session date, not an arbitrary fifty', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    // w.sessionId is dated 2026-08-11.
    const laterSessionId = await createSession(testApp, token, '2026-09-01');
    const earlierSessionId = await createSession(testApp, token, '2026-01-01');

    for (let i = 0; i < REPEAT_REFERRAL_LIST_LIMIT; i += 1) {
      await seedMatchingReferral(w, w.sessionId, 'GU9 7ZZ', 'GU97ZZ');
    }
    const later = await seedMatchingReferral(w, laterSessionId, 'GU9 7ZZ', 'GU97ZZ');
    const earlier = await seedMatchingReferral(w, earlierSessionId, 'GU9 7ZZ', 'GU97ZZ');
    const self = await seedMatchingReferral(w, w.sessionId, 'GU9 7ZZ', 'GU97ZZ');

    // Fifty on the middle date plus the later one is fifty-one candidates at
    // or after the middle date, so the cap must drop at least one of the
    // middle-dated fifty to keep the later one — and the earlier-dated one
    // can never make the cut at all.
    const list = await getRepeatReferrals(testApp, token, self);

    expect(list.body.count).toBe(REPEAT_REFERRAL_LIST_LIMIT + 2);
    expect(list.body.matches).toHaveLength(REPEAT_REFERRAL_LIST_LIMIT);

    const ids = list.body.matches.map((match) => match.referralId);
    expect(ids).toContain(later);
    expect(ids).not.toContain(earlier);
  });

  it('returns all fifty matches with count 50 when there are exactly fifty — the ordinary case is not made to look truncated', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    for (let i = 0; i < 50; i += 1) {
      await seedMatchingReferral(w, w.sessionId, 'GU9 7ZZ', 'GU97ZZ');
    }
    const self = await seedMatchingReferral(w, w.sessionId, 'GU9 7ZZ', 'GU97ZZ');

    const list = await getRepeatReferrals(testApp, token, self);

    expect(list.body.count).toBe(50);
    expect(list.body.matches).toHaveLength(50);
  });

  it('reports the same uncapped count from GET /referrals/{id} as from the list route', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const bulkCount = REPEAT_REFERRAL_LIST_LIMIT + 7;
    for (let i = 0; i < bulkCount; i += 1) {
      await seedMatchingReferral(w, w.sessionId, 'GU9 7ZZ', 'GU97ZZ');
    }
    const self = await seedMatchingReferral(w, w.sessionId, 'GU9 7ZZ', 'GU97ZZ');

    const detail = await getReferral(testApp, token, self);
    const list = await getRepeatReferrals(testApp, token, self);

    expect(detail.body.repeatReferrals?.count).toBe(bulkCount);
    expect(list.body.count).toBe(bulkCount);
    expect(list.body.matches).toHaveLength(REPEAT_REFERRAL_LIST_LIMIT);
  });
});

/**
 * `?excludePostcode=true` — the review screen's `Exclude postcode matches`
 * checkbox. `INITIAL_SPEC1.txt`, `#Reviewing a referral`; `API.md`, "The
 * `Exclude postcode matches` checkbox".
 */
describe('the Exclude postcode matches checkbox (?excludePostcode)', () => {
  it('with excludePostcode omitted, still matches on date of birth, postcode and phone all at once', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const shared = {
      refereeDateOfBirth: '1970-06-15',
      refereePostcode: 'GU1 4AA',
      refereePhone: '07700 900111',
    };
    await submitReferral(testApp, w, shared, { clientIp: nextClientIp() });
    const self = await submitReferral(testApp, w, shared, { clientIp: nextClientIp() });

    const list = await getRepeatReferrals(testApp, token, self.id);
    expect(list.body.matches[0]?.matchedOn).toEqual(['date_of_birth', 'postcode', 'phone']);
  });

  /**
   * `repeatReferralsQuerySchema` parses `excludePostcode` as one of the two
   * literal strings `'true'`/`'false'`, not `z.coerce.boolean()` — coercion
   * would turn the non-empty string `"false"` into `true`. A postcode-only
   * match is the fixture that tells the two apart: coerced to `true` it
   * would vanish, read correctly as `false` it stays.
   */
  it('reads ?excludePostcode=false as false, not true — a postcode-only match still shows', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    await submitReferral(
      testApp,
      w,
      {
        refereeDateOfBirth: '1970-06-15',
        refereePostcode: 'GU1 4AA',
        refereePhone: '07700 900111',
      },
      { clientIp: nextClientIp() },
    );
    const self = await submitReferral(
      testApp,
      w,
      {
        refereeDateOfBirth: '1971-07-16',
        refereePostcode: 'GU1 4AA',
        refereePhone: '07700 900222',
      },
      { clientIp: nextClientIp() },
    );

    const list = await getRepeatReferrals(testApp, token, self.id, '?excludePostcode=false');
    expect(list.body.matches).toHaveLength(1);
    expect(list.body.matches[0]?.matchedOn).toEqual(['postcode']);
  });

  it('?excludePostcode=banana is a 400', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { id } = await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

    const response = await testApp.request(
      `/api/v1/referrals/${id}/repeat-referrals?excludePostcode=banana`,
      { headers: authHeaders(token) },
    );
    expect(response.status).toBe(400);
  });

  it('drops a postcode-only match and recalculates count and mostRecentSessionDate — not just the list — while a phone match stays without postcode in its matchedOn even though the postcodes do in fact agree', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    // Later session: matches only on postcode.
    const laterSessionId = await createSession(testApp, token, '2026-08-20');
    // Earlier session: matches on phone, and happens to share the postcode too.
    const earlierSessionId = await createSession(testApp, token, '2026-08-06');

    const postcodeOnly = await submitReferral(
      testApp,
      inSession(w, laterSessionId),
      {
        refereeDateOfBirth: '1960-02-02',
        refereePostcode: 'GU5 5EE',
        refereePhone: '07700 900501',
      },
      { clientIp: nextClientIp() },
    );
    const phoneMatch = await submitReferral(
      testApp,
      inSession(w, earlierSessionId),
      {
        refereeDateOfBirth: '1961-03-03',
        refereePostcode: 'GU5 5EE',
        refereePhone: '07700 900500',
      },
      { clientIp: nextClientIp() },
    );
    const self = await submitReferral(
      testApp,
      w,
      {
        refereeDateOfBirth: '1975-01-01',
        refereePostcode: 'GU5 5EE',
        refereePhone: '07700 900500',
      },
      { clientIp: nextClientIp() },
    );

    // Positive control: with the checkbox unticked, both match and the most
    // recent session date is the later, postcode-only one.
    const before = await getRepeatReferrals(testApp, token, self.id);
    expect(before.body.count).toBe(2);
    expect(before.body.mostRecentSessionDate).toBe('2026-08-20');
    expect(
      before.body.matches.find((match) => match.referralId === postcodeOnly.id)?.matchedOn,
    ).toEqual(['postcode']);
    expect(
      before.body.matches.find((match) => match.referralId === phoneMatch.id)?.matchedOn,
    ).toEqual(['postcode', 'phone']);

    const after = await getRepeatReferrals(testApp, token, self.id, '?excludePostcode=true');

    // The postcode-only match is gone entirely, not merely unlabelled.
    expect(after.body.matches.map((match) => match.referralId)).toEqual([phoneMatch.id]);
    // Recalculated, not filtered client-side: had the list simply been
    // filtered, this would still read 2026-08-20 from the match that no
    // longer exists.
    expect(after.body.count).toBe(1);
    expect(after.body.mostRecentSessionDate).toBe('2026-08-06');
    // The remaining match still shares a postcode with the referral under
    // review, but the checkbox takes it out of the evidence reported.
    expect(after.body.matches[0]?.matchedOn).toEqual(['phone']);
  });

  it('returns { count: 0, mostRecentSessionDate: null, matches: [] } when the referral under review has no date of birth and no usable phone, only a postcode, and the checkbox is ticked', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    await submitReferral(testApp, w, { refereePostcode: 'GU8 8FF' }, { clientIp: nextClientIp() });
    const self = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU8 8FF' },
      { clientIp: nextClientIp() },
    );

    // A live submission always requires a date of birth (see
    // `referrals.schema.ts`), so this state — nothing but a postcode — is
    // only real after hand-editing, the same as the existing "nothing
    // matchable" fixture above.
    await db
      .update(referrals)
      .set({ refereeDateOfBirth: null, refereePhone: null, refereePhoneNormalised: null })
      .where(eq(referrals.id, self.id));

    // Positive control: unticked, the postcode still matches the other referral.
    const before = await getRepeatReferrals(testApp, token, self.id);
    expect(before.body.count).toBe(1);

    const after = await getRepeatReferrals(testApp, token, self.id, '?excludePostcode=true');
    expect(after.body).toEqual({ count: 0, mostRecentSessionDate: null, matches: [] });
  });

  it('refuses a team lead the list even with the checkbox set', async () => {
    const { world: w } = await referralWorld(NOW);
    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: leadToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const response = await lead.request(
      `/api/v1/referrals/${w.sessionId}/repeat-referrals?excludePostcode=true`,
      { headers: authHeaders(leadToken) },
    );
    expect(response.status).toBe(403);
  });

  /**
   * A referral that matches by date of birth alone, seeded directly through
   * Drizzle for the same reason `seedMatchingReferral` above is: fifty-plus
   * live submissions against a 5/60s limiter is not what this is testing.
   */
  async function seedDobMatchingReferral(
    world: ReferralWorld,
    sessionId: string,
    dateOfBirth: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(referrals).values({
      id,
      sessionId,
      status: 'active',
      referredAt: NOW,
      cancelledAt: null,
      cancelledReason: null,
      reviewComment: null,
      reviewedByUserId: null,
      referrerOrganisation: 'Exclude Postcode Cap Test Org',
      authorisedReferrerId: null,
      adults: 1,
      children: 0,
      isDelivery: 0,
      reasonId: world.reasonId,
      needsFuelHelp: 0,
      referrerName: null,
      referrerEmail: null,
      referrerPhone: null,
      refereeFirstName: null,
      refereeSurname: null,
      refereeDateOfBirth: dateOfBirth,
      refereeAddress: null,
      // Shares a postcode too, so excluding it only removes it from the
      // matching — the date of birth match must survive on its own.
      refereePostcode: 'GU9 7ZZ',
      refereePhone: null,
      refereePostcodeNormalised: 'GU97ZZ',
      refereePhoneNormalised: null,
      answersJson: null,
      piiPurgedAt: null,
      createdByUserId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return id;
  }

  it('still applies the fifty-match cap and the uncapped count when excludePostcode=true', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const bulkCount = REPEAT_REFERRAL_LIST_LIMIT + 5;
    for (let i = 0; i < bulkCount; i += 1) {
      await seedDobMatchingReferral(w, w.sessionId, '1955-05-05');
    }
    const self = await seedDobMatchingReferral(w, w.sessionId, '1955-05-05');

    const list = await getRepeatReferrals(testApp, token, self, '?excludePostcode=true');

    expect(list.body.matches).toHaveLength(50);
    expect(list.body.count).toBe(bulkCount);
    expect(list.body.count).toBeGreaterThan(list.body.matches.length);
  });

  it('still applies the twelve-month window when excludePostcode=true', async () => {
    // Same BST-straddling instants as "the twelve-month window, on
    // referredAt" above, computed by hand and independently of the code
    // under test.
    const NOW_STRADDLING_BST = '2026-08-20T23:30:00.000Z';
    const JUST_INSIDE = '2025-08-20T23:30:00.000Z';
    const JUST_OUTSIDE = '2025-08-20T23:29:00.000Z';

    const { testApp, token, world: w } = await referralWorld(NOW_STRADDLING_BST);

    const inside = await seedDobMatchingReferral(w, w.sessionId, '1944-04-04');
    const outside = await seedDobMatchingReferral(w, w.sessionId, '1944-04-04');
    const self = await seedDobMatchingReferral(w, w.sessionId, '1944-04-04');

    await db.update(referrals).set({ referredAt: JUST_INSIDE }).where(eq(referrals.id, inside));
    await db.update(referrals).set({ referredAt: JUST_OUTSIDE }).where(eq(referrals.id, outside));

    const list = await getRepeatReferrals(testApp, token, self, '?excludePostcode=true');
    expect(list.body.matches.map((match) => match.referralId)).toEqual([inside]);
  });
});

describe('migration 0019 backfill', () => {
  /**
   * Only the `UPDATE` statements from the real migration — the `ALTER TABLE`
   * and `CREATE INDEX` statements already ran once via `test/setup.ts` and
   * would error a second time. Reading them out of `env.TEST_MIGRATIONS`
   * rather than retyping the SQL is the point: a test that restated the
   * statements would prove nothing about the ones actually shipped.
   */
  function backfillStatements(): string[] {
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith('0019'));
    if (migration === undefined) {
      throw new Error('migration 0019 not found in TEST_MIGRATIONS — has it been renamed?');
    }
    return migration.queries.filter((query) => query.trim().toUpperCase().startsWith('UPDATE'));
  }

  async function runBackfill(): Promise<void> {
    for (const statement of backfillStatements()) {
      await env.DB.prepare(statement).run();
    }
  }

  /**
   * Inserts a referral row directly, with both normalised columns explicitly
   * `NULL` — the state every row was in before migration 0019 backfilled it.
   */
  async function seedRawReferral(
    world: ReferralWorld,
    overrides: { postcode?: string | null; phone?: string | null } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    const now = '2026-01-01T00:00:00.000Z';
    await db.insert(referrals).values({
      id,
      sessionId: world.sessionId,
      status: 'active',
      referredAt: now,
      cancelledAt: null,
      cancelledReason: null,
      reviewComment: null,
      reviewedByUserId: null,
      referrerOrganisation: 'Migration Test Org',
      authorisedReferrerId: null,
      adults: 1,
      children: 0,
      isDelivery: 0,
      reasonId: world.reasonId,
      needsFuelHelp: 0,
      referrerName: null,
      referrerEmail: null,
      referrerPhone: null,
      refereeFirstName: null,
      refereeSurname: null,
      refereeDateOfBirth: null,
      refereeAddress: null,
      refereePostcode: overrides.postcode ?? null,
      refereePhone: overrides.phone ?? null,
      refereePostcodeNormalised: null,
      refereePhoneNormalised: null,
      answersJson: null,
      piiPurgedAt: null,
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async function normalisedOf(
    id: string,
  ): Promise<{ postcode: string | null; phone: string | null }> {
    const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
    return {
      postcode: row?.refereePostcodeNormalised ?? null,
      phone: row?.refereePhoneNormalised ?? null,
    };
  }

  it('backfills a lower-case, spaced postcode to its settled form', async () => {
    const { world: w } = await referralWorld(NOW);
    const id = await seedRawReferral(w, { postcode: 'gu1 4aa' });

    await runBackfill();

    expect((await normalisedOf(id)).postcode).toBe('GU14AA');
  });

  it('backfills an unparseable postcode to NULL', async () => {
    const { world: w } = await referralWorld(NOW);
    const id = await seedRawReferral(w, { postcode: 'not a postcode' });

    await runBackfill();

    expect((await normalisedOf(id)).postcode).toBeNull();
  });

  /**
   * These caught a real defect, and that is why they seed a row first.
   *
   * `0019` originally ended the phone backfill with
   * `NOT GLOB '+44[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'` — 53
   * characters, over SQLite's 50-character LIKE/GLOB limit (measured against
   * this binding: 48 runs, 53 throws `LIKE or GLOB pattern too complex`).
   * **SQLite only evaluates a GLOB when there is a row to evaluate it
   * against**, so the statement ran perfectly against an empty table — which
   * is exactly what `test/setup.ts` applies every migration to. The whole
   * suite was green and the migration would have failed on the first
   * deployment that had a referral with a phone number on it.
   *
   * So: a migration test that only applies migrations proves nothing about a
   * pattern. Seed the row. See `docs/engineering/d1-constraints.md`.
   */
  it.each([['07700 900123'], ['+447700900123'], ['447700900123'], ['(07700) 900-123']])(
    'backfills phone number %s to +447700900123',
    async (raw) => {
      const { world: w } = await referralWorld(NOW);
      const id = await seedRawReferral(w, { phone: raw });

      await runBackfill();

      expect((await normalisedOf(id)).phone).toBe('+447700900123');
    },
  );

  it('backfills a non-UK number to NULL', async () => {
    const { world: w } = await referralWorld(NOW);
    const id = await seedRawReferral(w, { phone: '+1 555 0100' });

    await runBackfill();

    expect((await normalisedOf(id)).phone).toBeNull();
  });

  it('leaves both normalised columns NULL when the source columns are NULL', async () => {
    const { world: w } = await referralWorld(NOW);
    const id = await seedRawReferral(w, {});

    await runBackfill();

    expect(await normalisedOf(id)).toEqual({ postcode: null, phone: null });
  });

  // Idempotence is what makes the backfill safe to re-run against a database
  // where some rows are already settled and some are not. It holds because
  // each pair's first statement recomputes from the untouched source column.
  it('changes nothing on a second run — the backfill is idempotent', async () => {
    const { world: w } = await referralWorld(NOW);
    const id = await seedRawReferral(w, { postcode: 'gu1 4aa', phone: '07700 900123' });

    await runBackfill();
    const once = await normalisedOf(id);
    await runBackfill();
    const twice = await normalisedOf(id);

    expect(twice).toEqual(once);
    expect(twice).toEqual({ postcode: 'GU14AA', phone: '+447700900123' });
  });
});
