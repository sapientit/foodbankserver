import { encodeBase64Url, encodeBase64UrlText } from '../../src/core/base64url.ts';

/**
 * Builds signed Google ID tokens for tests, without a JWT library — the same
 * hand-rolled approach `google-provider.ts` verifies against.
 *
 * Shared between the pure unit tests (`test/google-provider.test.ts`) and the
 * end-to-end account-linking tests (`test/auth-flow.test.ts`), which both need
 * a real RS256-signed token and a matching JWKS response to mock `fetch` with.
 */

/** The `kid` a default signed token and its matching JWKS entry both use. */
export const GOOGLE_TEST_KID = 'test-key';

/** A plausible `GOOGLE_AUTH_CLIENT_ID` value for tests to configure and assert `aud` against. */
export const GOOGLE_TEST_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

/** Matches `GOOGLE_WORKSPACE_DOMAIN` in `config/constants.ts` — deliberately not imported, so a
 * test that hardcodes the wrong domain here would fail rather than pass by coincidence. */
export const GOOGLE_TEST_WORKSPACE_DOMAIN = 'guildfordfoodbank.org';

export interface GoogleTestKeyPair {
  readonly privateKey: CryptoKey;
  readonly jwk: JsonWebKey;
}

/** Generates a fresh RSA keypair for signing test Google ID tokens. */
export async function generateGoogleTestKeyPair(): Promise<GoogleTestKeyPair> {
  const generated = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  // The Workers runtime types declare one `generateKey` signature covering
  // both symmetric and asymmetric algorithms, returning `CryptoKey |
  // CryptoKeyPair` regardless — narrow it at runtime rather than casting.
  if (!('publicKey' in generated)) {
    throw new Error('generateKey unexpectedly returned a single CryptoKey, not a pair');
  }
  const keyPair = generated;

  // The Workers runtime types declare one `exportKey` signature for every
  // format, returning `ArrayBuffer | JsonWebKey` regardless of the literal
  // `'jwk'` passed — narrow it at runtime rather than casting.
  const exported = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  if (exported instanceof ArrayBuffer) {
    throw new Error('exportKey("jwk", ...) unexpectedly returned raw bytes');
  }

  return { privateKey: keyPair.privateKey, jwk: exported };
}

/** The JWKS response body `google-provider.ts` fetches from `GOOGLE_JWKS_URL`. */
export function googleJwksBody(keyPair: GoogleTestKeyPair, kid: string = GOOGLE_TEST_KID) {
  return {
    keys: [{ kid, kty: keyPair.jwk.kty, n: keyPair.jwk.n, e: keyPair.jwk.e }],
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Sensible claims for a signed-in Guildford Food Bank Workspace account, relative to a clock. */
export function defaultGoogleClaims(nowEpochSeconds: number): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: GOOGLE_TEST_CLIENT_ID,
    sub: 'google-subject-1',
    email: 'pete@guildfordfoodbank.org',
    email_verified: true,
    hd: GOOGLE_TEST_WORKSPACE_DOMAIN,
    name: 'Pete Bennett',
    exp: nowEpochSeconds + 3600,
  };
}

/** Signs an already-encoded header/payload pair. For tests that need a malformed one. */
export async function signGoogleTokenParts(
  privateKey: CryptoKey,
  headerPart: string,
  payloadPart: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  return `${headerPart}.${payloadPart}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Signs a well-formed Google ID token: a real RS256 header and the given claims. */
export function signGoogleIdToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  header: { alg?: string; kid?: string } = {},
): Promise<string> {
  const headerPart = encodeBase64UrlText(
    JSON.stringify({ alg: 'RS256', kid: GOOGLE_TEST_KID, ...header }),
  );
  const payloadPart = encodeBase64UrlText(JSON.stringify(claims));
  return signGoogleTokenParts(privateKey, headerPart, payloadPart);
}
