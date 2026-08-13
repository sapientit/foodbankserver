/**
 * Domain and security constants.
 *
 * These are policy, not configuration: they are the same in every environment,
 * and changing one is a deliberate decision that should show up in a diff.
 */

/**
 * Access tokens are stateless, so revocation only bites when one expires.
 * Fifteen minutes bounds that window while keeping refresh traffic low.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * A sign-in lasts eight hours, measured from the moment the person signed in.
 *
 * This is an absolute cap, not an idle timeout: a refresh token inherits the
 * expiry of the one it replaces, so carrying on working never pushes the cap
 * forward. Eight hours covers a session in the warehouse without signing a team
 * lead out halfway through marking attendance, and is short enough that a
 * shared tablet is not still signed in the next morning.
 */
export const SIGN_IN_TTL_SECONDS = 8 * 60 * 60;

/** Tolerance for clock skew between the signer and the verifier. */
export const JWT_CLOCK_LEEWAY_SECONDS = 60;

export const JWT_ISSUER = 'foodbank-api';
export const JWT_AUDIENCE = 'foodbank-web';

/** Path the refresh cookie is scoped to, so it is never sent to domain routes. */
export const REFRESH_COOKIE_NAME = 'foodbank_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** How far ahead the cron materialises sessions from recurring templates. */
export const SESSION_HORIZON_WEEKS = 6;

/**
 * How far ahead a team lead's session list looks, counted in days from today
 * in London and inclusive of today — so today through today plus six, a full
 * week of shifts including the one being worked.
 *
 * An admin has no such cap: the whole materialised six weeks is their planning
 * tool. A team lead runs the session in front of them, and the calendar six
 * weeks out is not theirs to read.
 */
export const TEAM_LEAD_SESSION_HORIZON_DAYS = 6;

/** Sessions default to this many households unless an admin overrides it. */
export const DEFAULT_SESSION_CAPACITY = 25;

/** How far ahead the unauthenticated session list looks. Not client-controllable. */
export const PUBLIC_SESSION_WINDOW_DAYS = 14;

/**
 * Bounds on a referral's dynamic answers.
 *
 * The referral form lives in the client, so the server has nothing to validate
 * the answers against and stores them as given. These are the only limits that
 * remain, and they exist because the submission is unauthenticated: without
 * them an open write accepts an arbitrarily large blob. They are generous
 * enough that no real form comes close.
 */
export const MAX_ANSWERS = 100;
export const MAX_ANSWER_KEY_LENGTH = 60;
export const MAX_ANSWERS_BYTES = 16 * 1024;

/**
 * How long the administrators' own note on a referral may be.
 *
 * Two thousand characters — a couple of paragraphs, which is what a note
 * about a household turns out to be, and far short of a document somebody
 * would paste in. It is generous next to `reviewComment`'s 200 because that is
 * one line about one decision, while this accumulates what the office knows.
 *
 * **The same number is written into `openapi.yaml` as `maxLength`**, so the
 * client refuses an over-long note before it is sent rather than showing an
 * administrator a `400` after they typed it. Change one and change the other.
 */
export const MAX_ADMIN_INFO_LENGTH = 2000;

/**
 * How long a text message is kept before the nightly job deletes it.
 *
 * **Policy, not configuration** — unlike `PII_RETENTION_DAYS`, which is unset
 * because the charity has not decided. This one they have: thirty days, for
 * reminders, replies, failures and loose replies alike. A text is a
 * conversation about one session and stops being useful within days of it, so
 * there is nothing to weigh against holding somebody's own words longer.
 *
 * That is why it lives here rather than in `env.ts`: an environment that could
 * set it to 3650 is an environment that can quietly break a stated promise.
 */
export const SMS_MESSAGE_RETENTION_DAYS = 30;

/**
 * How many reminders are in flight to the provider at once.
 *
 * A session of 25 households is 25 outbound requests. Sending them one at a
 * time is slow enough to time out a request; sending all 25 at once is a burst
 * at the provider for no gain. Five keeps a full session inside a few seconds.
 */
export const SMS_SEND_CONCURRENCY = 5;

/**
 * How far back the fuel help list reaches, counted from today in London.
 *
 * Fourteen **dates**, today included — so `today - 13` is the earliest session
 * listed, not `today - 14`. The charity asked for a fortnight and meant one:
 * counting fourteen days *back* from today would span fifteen dates and, with
 * weekly sessions, would catch three of them rather than two on the weeks
 * where the boundary lands on a session day.
 *
 * The list is rolling: the point is what has happened since it was last looked
 * at, and a fuel crisis from a year ago is not a reason to ring somebody
 * today. See `INITIAL_SPEC1.txt`, #Fuel help list.
 */
export const FUEL_HELP_WINDOW_DAYS = 14;

/**
 * How far back the repeat-referral count on the review screen looks, counted
 * on `referredAt`.
 *
 * Twelve months, expressed as days — and **deliberately the same period as
 * the retention purge** (`INITIAL_SPEC1.txt`, "Forgetting a referral", and
 * `PII_RETENTION_DAYS` in `config/env.ts`). Once a household's identifying
 * columns have been nulled there is nothing left on the row to match on, so
 * the two periods only stay honest together: shortening this window without
 * shortening the purge's would silently under-report, and the reverse would
 * count against a household the charity has already promised to forget.
 */
export const REPEAT_REFERRAL_LOOKBACK_DAYS = 365;

/**
 * How many repeat referrals the button behind the count will list.
 *
 * Fifty, the fifty most recent. The charity's reasoning, settled 2026-08-07:
 * past fifty nobody is going to read on, so listing more tells an
 * administrator nothing they were going to use — and several hundred other
 * households' names, addresses and phone numbers on one screen, assembled
 * because somebody opened one unrelated referral, is not a thing to build.
 * See `INITIAL_SPEC1.txt`, "Reviewing a referral".
 *
 * **The count is deliberately not capped.** A list of fifty against a count of
 * three hundred is what tells the administrator that fifty is not all of them,
 * so the two must not be made to agree by counting the truncated list.
 */
export const REPEAT_REFERRAL_LIST_LIMIT = 50;

/**
 * How many rows `POST /referrals/search` returns.
 *
 * Fifty, the fifty most recent by session date — the same number as
 * `REPEAT_REFERRAL_LIST_LIMIT` and a **separate constant on purpose**: the two
 * answer different questions (one household's duplicates, versus every
 * referral matching a postcode, phone number or date of birth an
 * administrator typed in), and there is no reason the two ceilings should
 * have to move together just because they happen to agree today.
 *
 * **The count is deliberately not capped.** A list of fifty against a count
 * of two hundred is how the administrator is told fifty is not all of them —
 * `INITIAL_SPEC1.txt`, "Searching for a referral".
 */
export const REFERRAL_SEARCH_LIMIT = 50;

/**
 * How long a session stays reserved to one administrator's browser.
 *
 * The browser claims a session, writes it to the spreadsheet, then reports
 * back. Ten minutes is generous for a write that takes seconds, and the
 * generosity is the point: expiring a claim out from under a browser that is
 * merely slow would hand the same session to somebody else and duplicate it.
 *
 * It cannot be indefinite either. The browser holds the only Google
 * credential and the only knowledge of whether its write landed, so a laptop
 * that closes mid-session leaves a claim nothing can ever complete — without
 * an expiry that session would be reserved forever and the queue would stop
 * dead at it. Ten minutes is the balance: long enough that a working browser
 * is never interrupted, short enough that an abandoned extract recovers
 * within one coffee break.
 *
 * See `INITIAL_SPEC1.txt`, "Sending referrals to the spreadsheet".
 */
export const EXTRACT_CLAIM_TTL_MINUTES = 10;
