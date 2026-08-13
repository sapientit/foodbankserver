import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/core/clock.ts';
import { createLogger } from '../src/core/log.ts';
import { REFERRAL_SEARCH_LIMIT } from '../src/config/constants.ts';
import { createDatabase } from '../src/db/client.ts';
import { auditEvents, referrals } from '../src/db/schema/referrals.ts';
import { authorisedReferrers, referralReasons } from '../src/db/schema/referrers.ts';
import { recurringSessions, sessions } from '../src/db/schema/sessions.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { purgeReferralPii } from '../src/modules/jobs/purge-pii.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';
import {
  setUpReferralWorld,
  submitReferral,
  UNKNOWN_REFERRER,
  type ReferralWorld,
} from './helpers/referral-fixtures.ts';

/**
 * `POST /referrals/search` — an administrator finding a referral by postcode,
 * phone number and/or date of birth when somebody rings up.
 * `INITIAL_SPEC1.txt`, `#Searching for a referral`; `API.md`, "Finding a
 * referral when somebody rings".
 */

const db = createDatabase(env.DB);

/**
 * A referral submission always requires a date of birth and the session date
 * in `setUpReferralWorld` is 2026-08-11, so this sits comfortably before it.
 */
const NOW = '2026-08-04T09:00:00.000Z';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

/**
 * Referral submission is rate limited per client address, and several tests
 * here seed more than one referral. A counter rather than a shared or random
 * address, following `test/repeat-referrals.test.ts`.
 */
let clientIpCounter = 0;
function nextClientIp(): string {
  clientIpCounter += 1;
  return `203.0.114.${String(clientIpCounter)}`;
}

async function referralWorld(
  now: string,
): Promise<{ testApp: TestApp; token: string; world: ReferralWorld }> {
  const testApp = buildTestApp({ clock: fixedClock(now) });
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  const world = await setUpReferralWorld(testApp, accessToken);
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

/**
 * The nine fields a result row carries, and nothing else. Declared by hand
 * rather than imported from `referrals.mapper.ts` on purpose: a test that took
 * its expected shape from the mapper would agree with the mapper however the
 * mapper changed, which is a test that proves nothing.
 */
interface ReferralSearchResultBody {
  readonly referralId: string;
  readonly sessionDate: string;
  readonly status: string;
  readonly refereeFirstName: string | null;
  readonly refereeSurname: string | null;
  readonly refereePostcode: string | null;
  readonly refereePhone: string | null;
  readonly reasonId: string;
  readonly referrerName: string | null;
}

interface ReferralSearchResponseBody {
  readonly count: number;
  readonly results: ReferralSearchResultBody[];
}

async function search(
  testApp: TestApp,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: ReferralSearchResponseBody }> {
  const response = await testApp.request('/api/v1/referrals/search', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });
  const parsed: ReferralSearchResponseBody = await response.json();
  return { status: response.status, body: parsed };
}

beforeEach(async () => {
  await db.delete(auditEvents);
  await db.delete(referrals);
  await db.delete(referralReasons);
  await db.delete(authorisedReferrers);
  await db.delete(sessions);
  await db.delete(recurringSessions);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('POST /referrals/search — role access', () => {
  it('is admin only: a team lead and a fuel administrator get 403, an unauthenticated caller gets 401, an admin gets 200', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { id } = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU40 1AA' },
      { clientIp: nextClientIp() },
    );
    const body = JSON.stringify({ postcode: 'GU40 1AA' });

    const lead = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: leadToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });
    const leadResponse = await lead.request('/api/v1/referrals/search', {
      method: 'POST',
      headers: json(leadToken),
      body,
    });
    expect(leadResponse.status).toBe(403);

    const fuel = buildTestApp({ clock: fixedClock(NOW) });
    const { accessToken: fuelToken } = await devLogin(fuel, {
      email: 'fuel@foodbank.org',
      role: 'fuel_admin',
    });
    const fuelResponse = await fuel.request('/api/v1/referrals/search', {
      method: 'POST',
      headers: json(fuelToken),
      body,
    });
    expect(fuelResponse.status).toBe(403);

    const unauth = await testApp.request('/api/v1/referrals/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(unauth.status).toBe(401);

    // Positive control: the same request, as an admin, succeeds — and finds
    // the referral. A 200 alone would still pass if the three refusals above
    // were refusing a search that could never match anything.
    const adminResponse = await testApp.request('/api/v1/referrals/search', {
      method: 'POST',
      headers: json(token),
      body,
    });
    expect(adminResponse.status).toBe(200);
    expect(await adminResponse.json()).toMatchObject({
      count: 1,
      results: [{ referralId: id }],
    });
  });
});

describe('at least one identifier is required', () => {
  it('refuses an empty body with 400', async () => {
    const { testApp, token } = await referralWorld(NOW);
    const response = await testApp.request('/api/v1/referrals/search', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  /**
   * `surnamePrefix` is a filter, not a fourth identifier. A surname on its own
   * would hand back every household of that name the food bank has ever fed,
   * which is the thing this endpoint exists not to do —
   * `INITIAL_SPEC1.txt`, `#Searching for a referral`.
   */
  it('refuses a surnamePrefix supplied without a postcode, phone number or date of birth with 400', async () => {
    const { testApp, token } = await referralWorld(NOW);
    const response = await testApp.request('/api/v1/referrals/search', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ surnamePrefix: 'Wintergreen' }),
    });
    expect(response.status).toBe(400);
  });

  it('accepts a surnamePrefix alongside an identifier', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { id } = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU40 1BB', refereeSurname: 'Wintergreen' },
      { clientIp: nextClientIp() },
    );

    const response = await search(testApp, token, {
      postcode: 'GU40 1BB',
      surnamePrefix: 'Wintergreen',
    });
    expect(response.status).toBe(200);
    expect(response.body.results.map((row) => row.referralId)).toEqual([id]);
  });

  /**
   * `referralSearchSchema` is a plain `z.object`, not a `z.strictObject` —
   * unlike `referralAdminAmendSchema`. Zod strips a key the schema does not
   * declare rather than rejecting the request for it, so a body carrying only
   * an unrecognised key is parsed down to `{}` and then fails the same
   * "supply something" refinement as an empty body. Asserted here rather than
   * assumed, per the brief: this is what it actually does, not what a
   * strict-object route would do.
   */
  it('strips an unrecognised key rather than rejecting it for being unknown, then refuses the now-empty body with 400', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const response = await testApp.request('/api/v1/referrals/search', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ postcodeTypo: 'GU1 4AA' }),
    });
    expect(response.status).toBe(400);

    // The 400 above is the refinement failing on an empty parsed body, and it
    // would look identical if the route rejected the unknown key outright.
    // Only a body carrying the same unknown key **and** a usable identifier
    // tells the two apart: a strict object would refuse this too.
    const { id } = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU40 1CC' },
      { clientIp: nextClientIp() },
    );
    const withIdentifier = await search(testApp, token, {
      postcode: 'GU40 1CC',
      postcodeTypo: 'GU1 4AA',
    });
    expect(withIdentifier.status).toBe(200);
    expect(withIdentifier.body.results.map((row) => row.referralId)).toEqual([id]);
  });
});

describe('each identifier finds a referral on its own', () => {
  it('finds by postcode alone', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { id } = await submitReferral(
      testApp,
      w,
      {
        refereePostcode: 'GU40 2AA',
        refereeDateOfBirth: '1980-01-01',
        refereePhone: '07700 900410',
      },
      { clientIp: nextClientIp() },
    );

    const response = await search(testApp, token, { postcode: 'GU40 2AA' });
    expect(response.status).toBe(200);
    expect(response.body.results.map((row) => row.referralId)).toEqual([id]);
    // The postcode comes back as it was typed on the form, not in the settled
    // form the match ran on: this row is read back to a caller on the phone.
    expect(response.body.results[0]).toMatchObject({
      refereePostcode: 'GU40 2AA',
      refereePhone: '07700 900410',
      reasonId: w.reasonId,
      referrerName: 'Jane Fieldsworth',
    });
  });

  it('finds by phone number alone', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { id } = await submitReferral(
      testApp,
      w,
      {
        refereePostcode: 'GU40 3BB',
        refereeDateOfBirth: '1981-02-02',
        refereePhone: '07700 900420',
      },
      { clientIp: nextClientIp() },
    );

    const response = await search(testApp, token, { phone: '07700 900420' });
    expect(response.status).toBe(200);
    expect(response.body.results.map((row) => row.referralId)).toEqual([id]);
    expect(response.body.results[0]).toMatchObject({
      refereePostcode: 'GU40 3BB',
      refereePhone: '07700 900420',
      reasonId: w.reasonId,
      referrerName: 'Jane Fieldsworth',
    });
  });

  /**
   * The row projection in full, asserted with `toEqual` rather than
   * `toMatchObject`: this is the test that fails when a tenth field is added
   * to the result. The date of birth is the identifier that must **not** come
   * back, so searching on it and then reading the whole row is the sharpest
   * place to pin the shape.
   */
  it('finds by date of birth alone, and a result row carries exactly the ten agreed fields', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { id } = await submitReferral(
      testApp,
      w,
      {
        refereePostcode: 'GU40 4CC',
        refereeDateOfBirth: '1982-03-03',
        refereePhone: '07700 900430',
        refereeFirstName: 'Alice',
        refereeSurname: 'Wintergreen',
        answers: { Dietary: 'no pork', Secondary: 'a-reason-id-the-server-never-reads' },
      },
      { clientIp: nextClientIp() },
    );

    const response = await search(testApp, token, { dateOfBirth: '1982-03-03' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      count: 1,
      results: [
        {
          referralId: id,
          sessionDate: '2026-08-11',
          status: 'active',
          refereeFirstName: 'Alice',
          refereeSurname: 'Wintergreen',
          refereePostcode: 'GU40 4CC',
          refereePhone: '07700 900430',
          reasonId: w.reasonId,
          referrerName: 'Jane Fieldsworth',
          // Whole and untouched. `Secondary` is in here as an ordinary answer,
          // not lifted out into a field of its own — the server does not know
          // that key means anything and must not learn.
          answers: { Dietary: 'no pork', Secondary: 'a-reason-id-the-server-never-reads' },
        },
      ],
    });
  });
});

describe('normalisation — the same settled-form rule as matching', () => {
  it('finds the same referral by postcode typed gu234xx, GU23 4XX or GU234XX', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { id } = await submitReferral(
      testApp,
      w,
      { refereePostcode: 'GU23 4XX' },
      { clientIp: nextClientIp() },
    );

    for (const typed of ['gu234xx', 'GU23 4XX', 'GU234XX']) {
      const response = await search(testApp, token, { postcode: typed });
      expect(response.body.results.map((row) => row.referralId)).toEqual([id]);
    }
  });

  it('finds the same referral by phone written 01483 123456 or +441483123456', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { id } = await submitReferral(
      testApp,
      w,
      { refereePhone: '01483 123456' },
      { clientIp: nextClientIp() },
    );

    for (const typed of ['01483 123456', '+441483123456']) {
      const response = await search(testApp, token, { phone: typed });
      expect(response.body.results.map((row) => row.referralId)).toEqual([id]);
    }
  });
});

it('returns count 0 with 200, not a 400, when the only supplied value is a postcode the rule cannot settle', async () => {
  const { testApp, token, world: w } = await referralWorld(NOW);
  // Present so a bug that ignored the unusable value and matched on nothing
  // in particular would still show up as a false positive rather than
  // trivially passing on an empty database.
  await submitReferral(testApp, w, {}, { clientIp: nextClientIp() });

  const response = await search(testApp, token, { postcode: 'NOTVALID' });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ count: 0, results: [] });
});

it('returns all three referrals when a postcode, a phone and a date of birth each match a different one — OR, not AND', async () => {
  const { testApp, token, world: w } = await referralWorld(NOW);
  const byPostcode = await submitReferral(
    testApp,
    w,
    { refereePostcode: 'GU41 5DD', refereePhone: '07700 900441', refereeDateOfBirth: '1971-01-01' },
    { clientIp: nextClientIp() },
  );
  const byPhone = await submitReferral(
    testApp,
    w,
    { refereePostcode: 'GU41 6EE', refereePhone: '07700 900442', refereeDateOfBirth: '1972-02-02' },
    { clientIp: nextClientIp() },
  );
  const byDateOfBirth = await submitReferral(
    testApp,
    w,
    { refereePostcode: 'GU41 7FF', refereePhone: '07700 900443', refereeDateOfBirth: '1973-03-03' },
    { clientIp: nextClientIp() },
  );

  // Each supplied value is on file for exactly one of the three, so an AND
  // would return nothing at all and only a genuine OR returns all three.
  const response = await search(testApp, token, {
    postcode: 'GU41 5DD',
    phone: '07700 900442',
    dateOfBirth: '1973-03-03',
  });

  expect(response.body.count).toBe(3);
  expect(response.body.results.map((row) => row.referralId).sort()).toEqual(
    [byPostcode.id, byPhone.id, byDateOfBirth.id].sort(),
  );
});

/**
 * `surnamePrefix` — the narrowing filter for the postcode that turns out to be
 * a hostel. It is `AND`ed around the whole identifier match, so it applies to
 * every arm, and it matches the start of the surname rather than anywhere in
 * it.
 */
describe('surnamePrefix narrows what the identifiers found', () => {
  /** Two households sharing one postcode — the hostel case, in miniature. */
  async function twoAtOnePostcode(
    testApp: TestApp,
    world: ReferralWorld,
  ): Promise<{ wintergreen: string; ashdown: string }> {
    const wintergreen = await submitReferral(
      testApp,
      world,
      {
        refereePostcode: 'GU45 1AA',
        refereeSurname: 'Wintergreen',
        refereePhone: '07700 900451',
        refereeDateOfBirth: '1961-01-01',
      },
      { clientIp: nextClientIp() },
    );
    const ashdown = await submitReferral(
      testApp,
      world,
      {
        refereePostcode: 'GU45 1AA',
        refereeSurname: 'Ashdown',
        refereePhone: '07700 900452',
        refereeDateOfBirth: '1962-02-02',
      },
      { clientIp: nextClientIp() },
    );
    return { wintergreen: wintergreen.id, ashdown: ashdown.id };
  }

  it('matches the start of the surname whatever case it is typed in', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { wintergreen, ashdown } = await twoAtOnePostcode(testApp, w);

    // Positive control: without the filter the postcode returns both.
    const unfiltered = await search(testApp, token, { postcode: 'GU45 1AA' });
    expect(unfiltered.body.results.map((row) => row.referralId).sort()).toEqual(
      [wintergreen, ashdown].sort(),
    );

    // The surname on file is `Wintergreen`; none of these is typed that way.
    for (const typed of ['wint', 'WINT', 'WiNtErGrEeN', 'wintergreen']) {
      const response = await search(testApp, token, {
        postcode: 'GU45 1AA',
        surnamePrefix: typed,
      });
      expect(response.status).toBe(200);
      expect(response.body.count).toBe(1);
      expect(response.body.results.map((row) => row.referralId)).toEqual([wintergreen]);
    }
  });

  /**
   * A long prefix must answer, not fail.
   *
   * The schema allows a hundred characters, and the first implementation of
   * this filter built a `LIKE` pattern out of them. SQLite caps a `LIKE`
   * pattern at fifty characters and **only evaluates it once there is a row to
   * evaluate it against** — so this returned a `500` against a populated
   * database while every test against an empty one passed. That is the same
   * trap migration `0019` fell into; see `docs/engineering/d1-constraints.md`.
   * The row seeded below is the whole point of the test.
   */
  it('answers a surnamePrefix longer than SQLite will accept as a LIKE pattern', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    await twoAtOnePostcode(testApp, w);

    for (const length of [60, 100]) {
      const response = await search(testApp, token, {
        postcode: 'GU45 1AA',
        surnamePrefix: 'W'.repeat(length),
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ count: 0, results: [] });
    }

    // Positive control: an ordinary prefix still finds its household, so the
    // fix cannot be "quietly refuse anything long".
    const real = await search(testApp, token, {
      postcode: 'GU45 1AA',
      surnamePrefix: 'Wintergreen',
    });
    expect(real.body.count).toBe(1);
  });

  it('is a prefix and not a substring: a fragment from the middle of the surname matches nothing', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    await twoAtOnePostcode(testApp, w);

    for (const middle of ['ntergreen', 'green', 'shdown']) {
      const response = await search(testApp, token, {
        postcode: 'GU45 1AA',
        surnamePrefix: middle,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ count: 0, results: [] });
    }
  });

  it('applies to every arm of the identifier match, not only the last one', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { wintergreen, ashdown } = await twoAtOnePostcode(testApp, w);

    // The postcode arm reaches both; the date-of-birth arm reaches only
    // Ashdown. A filter written flat alongside the identifiers rather than
    // bracketed around them would bind as `dateOfBirth OR (postcode AND
    // surname)` and hand back Ashdown here, the one household the
    // administrator asked to exclude.
    const response = await search(testApp, token, {
      postcode: 'GU45 1AA',
      dateOfBirth: '1962-02-02',
      surnamePrefix: 'wint',
    });

    expect(response.body.count).toBe(1);
    expect(response.body.results.map((row) => row.referralId)).toEqual([wintergreen]);
    expect(response.body.results.map((row) => row.referralId)).not.toContain(ashdown);
  });

  it('does not match a referral with no surname on file', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { wintergreen } = await twoAtOnePostcode(testApp, w);

    // A row can have a null surname — a bulk-seeded referral, or one whose
    // personal data has been purged — and `LIKE` against `NULL` is `NULL`, so
    // it drops out rather than matching everything. The surname is nulled
    // directly here because the purge would also null the postcode the search
    // runs on, leaving nothing to distinguish the two behaviours.
    await db.update(referrals).set({ refereeSurname: null }).where(eq(referrals.id, wintergreen));

    const filtered = await search(testApp, token, {
      postcode: 'GU45 1AA',
      surnamePrefix: 'wint',
    });
    expect(filtered.body).toEqual({ count: 0, results: [] });

    const control = await search(testApp, token, {
      postcode: 'GU45 1AA',
      surnamePrefix: 'ash',
    });
    expect(control.body.count).toBe(1);
  });

  /**
   * The repository escapes `%` and `_` before building the `LIKE`. A filter
   * that silently stops filtering is worse than one that finds nothing: `%`
   * behaving as a wildcard would hand back the whole hostel to somebody who
   * typed a stray character.
   */
  it('treats LIKE metacharacters as ordinary letters rather than wildcards', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const { wintergreen, ashdown } = await twoAtOnePostcode(testApp, w);

    for (const metacharacter of ['%', '_intergreen', 'Wintergree_']) {
      const response = await search(testApp, token, {
        postcode: 'GU45 1AA',
        surnamePrefix: metacharacter,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ count: 0, results: [] });
    }

    // Positive control: the two households are there to be found, so the
    // empty results above are the escaping working and not an empty database.
    const unfiltered = await search(testApp, token, { postcode: 'GU45 1AA' });
    expect(unfiltered.body.results.map((row) => row.referralId).sort()).toEqual(
      [wintergreen, ashdown].sort(),
    );
  });
});

it('returns cancelled and rejected referrals, each carrying its own status', async () => {
  const { testApp, token, world: w } = await referralWorld(NOW);
  const cancelled = await submitReferral(
    testApp,
    w,
    { refereePostcode: 'GU42 8GG' },
    { clientIp: nextClientIp() },
  );
  const rejected = await submitReferral(
    testApp,
    w,
    { ...UNKNOWN_REFERRER, refereePostcode: 'GU42 9HH' },
    { clientIp: nextClientIp() },
  );

  await testApp.request(`/api/v1/referrals/${cancelled.id}/cancel`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ reason: 'No longer needed' }),
  });
  await testApp.request(`/api/v1/referrals/${rejected.id}/reject`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ comment: 'Not an authorised referrer' }),
  });

  const cancelledResult = await search(testApp, token, { postcode: 'GU42 8GG' });
  const rejectedResult = await search(testApp, token, { postcode: 'GU42 9HH' });

  expect(cancelledResult.body.results).toEqual([
    expect.objectContaining({ referralId: cancelled.id, status: 'cancelled' }),
  ]);
  expect(rejectedResult.body.results).toEqual([
    expect.objectContaining({ referralId: rejected.id, status: 'rejected' }),
  ]);
});

it('finds a referral referred more than twelve months ago, unlike the repeat-referral list which would exclude it', async () => {
  const { testApp, token, world: w } = await referralWorld(NOW);
  const old = await submitReferral(
    testApp,
    w,
    { refereePostcode: 'GU43 1JJ' },
    { clientIp: nextClientIp() },
  );
  const recent = await submitReferral(
    testApp,
    w,
    { refereePostcode: 'GU43 1JJ' },
    { clientIp: nextClientIp() },
  );

  await db
    .update(referrals)
    .set({ referredAt: '2020-01-01T00:00:00.000Z' })
    .where(eq(referrals.id, old.id));

  // The contrast: the twelve-month repeat-referral count for `recent` does
  // not see `old` at all.
  const detail = await testApp.request(`/api/v1/referrals/${recent.id}`, {
    headers: authHeaders(token),
  });
  const detailBody: { repeatReferrals?: { count: number } } = await detail.json();
  expect(detailBody.repeatReferrals?.count).toBe(0);

  // The search reaches it anyway — there is no twelve-month window here.
  const response = await search(testApp, token, { postcode: 'GU43 1JJ' });
  expect(response.body.results.map((row) => row.referralId).sort()).toEqual(
    [old.id, recent.id].sort(),
  );
});

it('does not find a referral once its personal data has been purged', async () => {
  const { testApp, token, world: w } = await referralWorld(NOW);
  const submitted = await submitReferral(
    testApp,
    w,
    {
      refereePostcode: 'GU44 2KK',
      refereePhone: '07700 900450',
      refereeDateOfBirth: '1955-05-05',
    },
    { clientIp: nextClientIp() },
  );

  // Positive control, before the purge: all three identifiers find it. Without
  // this the three assertions below would still pass if the referral had never
  // been findable in the first place.
  expect((await search(testApp, token, { postcode: 'GU44 2KK' })).body.count).toBe(1);
  expect((await search(testApp, token, { phone: '07700 900450' })).body.count).toBe(1);
  expect((await search(testApp, token, { dateOfBirth: '1955-05-05' })).body.count).toBe(1);

  await db
    .update(referrals)
    .set({ referredAt: '2020-01-01T00:00:00.000Z' })
    .where(eq(referrals.id, submitted.id));
  await purgeReferralPii({
    db,
    clock: fixedClock(NOW),
    logger: createLogger('silent'),
    retentionDays: 365,
  });

  expect(await search(testApp, token, { postcode: 'GU44 2KK' })).toMatchObject({
    body: { count: 0, results: [] },
  });
  expect(await search(testApp, token, { phone: '07700 900450' })).toMatchObject({
    body: { count: 0, results: [] },
  });
  expect(await search(testApp, token, { dateOfBirth: '1955-05-05' })).toMatchObject({
    body: { count: 0, results: [] },
  });
});

/**
 * Seeded directly through Drizzle rather than through fifty-plus live
 * submissions, following `test/repeat-referrals.test.ts`'s "the fifty-match
 * cap" fixture — the referral limiter is 5/60s and matching only needs the
 * settled columns to be right.
 */
describe('ordering and the fifty-result cap', () => {
  async function seedSearchableReferral(
    world: ReferralWorld,
    sessionId: string,
    postcode: string,
    postcodeNormalised: string,
    surname: string | null = null,
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
      referrerOrganisation: 'Search Cap Test Org',
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
      refereeSurname: surname,
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

  it('caps results at fifty but reports the true, larger count', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const bulkCount = REFERRAL_SEARCH_LIMIT + 5;
    for (let i = 0; i < bulkCount; i += 1) {
      await seedSearchableReferral(w, w.sessionId, 'GU9 7ZZ', 'GU97ZZ');
    }

    const response = await search(testApp, token, { postcode: 'GU9 7ZZ' });

    // The concrete value, not just the constant, so a change to
    // `REFERRAL_SEARCH_LIMIT` is a visible change to this test.
    expect(response.body.results).toHaveLength(50);
    expect(response.body.count).toBe(bulkCount);
    expect(response.body.count).toBeGreaterThan(response.body.results.length);
  });

  /**
   * The case that catches a filter applied to the rows but not to the count.
   * The count and the capped rows come from two separate queries, and an
   * administrator narrowing a hostel postcode by surname reads the count to
   * decide whether the fifty rows in front of them are the whole answer — a
   * count of 67 under a filtered list of Wintergreens says the filter did not
   * work, when in fact it did.
   */
  it('applies the surname filter to the count as well as to the capped fifty rows', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const wanted = REFERRAL_SEARCH_LIMIT + 5;
    const unwanted = 12;
    for (let i = 0; i < wanted; i += 1) {
      await seedSearchableReferral(w, w.sessionId, 'GU9 7ZZ', 'GU97ZZ', 'Wintergreen');
    }
    for (let i = 0; i < unwanted; i += 1) {
      await seedSearchableReferral(w, w.sessionId, 'GU9 7ZZ', 'GU97ZZ', 'Ashdown');
    }

    // Unfiltered first, so the numbers below are known to be a narrowing of a
    // larger set rather than everything there was.
    const unfiltered = await search(testApp, token, { postcode: 'GU9 7ZZ' });
    expect(unfiltered.body.count).toBe(wanted + unwanted);

    const response = await search(testApp, token, {
      postcode: 'GU9 7ZZ',
      surnamePrefix: 'wint',
    });

    expect(response.body.count).toBe(wanted);
    expect(response.body.results).toHaveLength(50);
    expect(response.body.results.every((row) => row.refereeSurname === 'Wintergreen')).toBe(true);
  });

  it('orders results by session date, newest first', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const early = await createSession(testApp, token, '2026-08-06');
    const latest = await createSession(testApp, token, '2026-08-20');
    const middle = await createSession(testApp, token, '2026-08-13');

    const a = await seedSearchableReferral(w, early, 'GU9 7ZZ', 'GU97ZZ');
    const b = await seedSearchableReferral(w, latest, 'GU9 7ZZ', 'GU97ZZ');
    const c = await seedSearchableReferral(w, middle, 'GU9 7ZZ', 'GU97ZZ');

    const response = await search(testApp, token, { postcode: 'GU9 7ZZ' });

    expect(response.body.results.map((row) => row.referralId)).toEqual([b, c, a]);
    expect(response.body.results.map((row) => row.sessionDate)).toEqual([
      '2026-08-20',
      '2026-08-13',
      '2026-08-06',
    ]);
  });
});

describe('the response allowlist', () => {
  /**
   * A result row is what an administrator needs to recognise the household on
   * the phone: name, postcode, phone number, reason, referrer and session date.
   * It is deliberately **not** the referral. The address is the field that
   * turns a hostel postcode into a screen of other people's front doors, the
   * date of birth is only ever an input here, and the answers, the review
   * comment and the referrer's own contact details belong to
   * `GET /referrals/{id}` — the one result the administrator actually wanted.
   *
   * Asserted against the raw response text rather than a parsed object, which
   * is the point of the test: a value nested somewhere nobody thought to look
   * still fails it.
   */
  it('never carries the date of birth, the address, an answer, the review comment, the referrer email or phone, or the session location — asserted on the raw response text', async () => {
    const { testApp, token, world: w } = await referralWorld(NOW);
    const distinctivePostcode = 'GU48 9ZZ';
    const distinctivePhone = '07700 900489';
    const distinctiveDob = '1948-09-09';
    const distinctiveAddress = '7 Marchpane Cottages';

    const { id } = await submitReferral(
      testApp,
      w,
      {
        ...UNKNOWN_REFERRER,
        refereePostcode: distinctivePostcode,
        refereePhone: distinctivePhone,
        refereeDateOfBirth: distinctiveDob,
        refereeAddress: distinctiveAddress,
        answers: { Dietary: 'Allergic to peanuts specifically' },
      },
      { clientIp: nextClientIp() },
    );

    // Held for review, since the referrer address is not on the authorised
    // list — accepting it attaches a review comment to search on too.
    await testApp.request(`/api/v1/referrals/${id}/accept`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ comment: 'Confidential note: watch this referrer closely' }),
    });

    const response = await testApp.request('/api/v1/referrals/search', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        postcode: distinctivePostcode,
        phone: distinctivePhone,
        dateOfBirth: distinctiveDob,
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();

    for (const shouldNotLeak of [
      distinctiveDob,
      'refereeDateOfBirth',
      distinctiveAddress,
      'refereeAddress',
      'Confidential note',
      'reviewComment',
      UNKNOWN_REFERRER.referrerEmail,
      'referrerEmail',
      '01483 000111', // the referrer's own phone number
      'referrerPhone',
      UNKNOWN_REFERRER.referrerOrganisation,
      'Church Hall', // the session location
      'sessionLocation',
    ]) {
      expect(text).not.toContain(shouldNotLeak);
    }

    // Positive control: the row was rendered in full, so the absences above
    // are the allowlist working rather than an empty or errored response.
    expect(text).toContain(id);
    expect(text).toContain(distinctivePostcode);
    expect(text).toContain(distinctivePhone);
    expect(text).toContain(w.reasonId);
    expect(text).toContain('Jane Fieldsworth'); // referrerName

    // The answers come through whole, and that is deliberate: the secondary
    // cause and the additional crisis detail live in there under keys only the
    // referral application knows. The review comment above is the contrast —
    // it is a column the server owns, and it stays out.
    expect(text).toContain('Allergic to peanuts specifically');
    expect(JSON.parse(text).results[0].answers).toEqual({
      Dietary: 'Allergic to peanuts specifically',
    });
  });
});
