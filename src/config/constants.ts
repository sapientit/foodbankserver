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
