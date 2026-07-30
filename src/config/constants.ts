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
 * Fourteen days rather than the more common thirty. This system holds names,
 * addresses and reasons for needing food, so a stolen refresh token is worth
 * more than it would be elsewhere.
 */
export const REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;

/** Tolerance for clock skew between the signer and the verifier. */
export const JWT_CLOCK_LEEWAY_SECONDS = 60;

export const JWT_ISSUER = 'foodbank-api';
export const JWT_AUDIENCE = 'foodbank-web';

/** Path the refresh cookie is scoped to, so it is never sent to domain routes. */
export const REFRESH_COOKIE_NAME = 'foodbank_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** A referral may be amended by its edit key for this long, and no longer. */
export const REFERRAL_EDIT_KEY_TTL_SECONDS = 15 * 60;

/** How far ahead the cron materialises sessions from recurring templates. */
export const SESSION_HORIZON_WEEKS = 6;

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
