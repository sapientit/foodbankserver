import { z } from 'zod';
import {
  GOOGLE_ID_TOKEN_ISSUERS,
  GOOGLE_JWKS_URL,
  GOOGLE_WORKSPACE_DOMAIN,
  JWT_CLOCK_LEEWAY_SECONDS,
} from '../../../config/constants.ts';
import type { AppConfig } from '../../../config/env.ts';
import { decodeBase64Url, decodeBase64UrlText } from '../../../core/base64url.ts';
import type { Clock } from '../../../core/clock.ts';
import { UnauthorizedError } from '../../../core/errors.ts';
import { parseOrThrow } from '../../../http/validate.ts';
import { googleLoginSchema } from '../auth.schema.ts';
import type { IdentityClaim, IdentityProvider } from '../identity-provider.ts';

/**
 * Verifies a Google ID token and turns it into a claim.
 *
 * Hand-rolled with WebCrypto rather than a JWT library, the same choice
 * `token.service.ts` already made for the server's own tokens — see that
 * file for the shape this follows: algorithm pinned as a literal before
 * anything else runs, every failure throws the same generic error, and
 * claims are only trusted once the signature is verified.
 *
 * **No client secret is used, and none is needed.** This only ever proves
 * identity from a token the browser already holds; it never exchanges a code
 * with Google or calls a Google API on the user's behalf. That is what the
 * separate `GOOGLE_OAUTH_CLIENT_ID` (the spreadsheet extract's client, which
 * does need a user's consent for the Sheets scope) is for.
 */
export function createGoogleProvider(config: AppConfig, clock: Clock): IdentityProvider {
  return {
    name: 'google',
    async authenticate(input: unknown): Promise<IdentityClaim> {
      const { idToken } = parseOrThrow(googleLoginSchema, input);
      const claims = await verifyIdToken(idToken, config.googleAuthClientId, clock);

      return {
        provider: 'google',
        subject: claims.sub,
        email: claims.email,
        emailVerified: claims.email_verified,
        displayName: claims.name ?? claims.email,
      };
    },
  };
}

const googleHeaderSchema = z.object({
  alg: z.literal('RS256'),
  kid: z.string().min(1),
});

const googleClaimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1),
  email: z.string().min(1),
  email_verified: z.boolean(),
  // Present only for a Google Workspace account, which is exactly what makes
  // it the right claim to gate on — an ordinary Gmail address never has one,
  // whatever name is on the account.
  hd: z.string().optional(),
  name: z.string().optional(),
  exp: z.number(),
});

async function verifyIdToken(
  idToken: string,
  clientId: string | undefined,
  clock: Clock,
): Promise<z.infer<typeof googleClaimsSchema>> {
  // config/env.ts refuses to boot with AUTH_MODE=google and no client id
  // configured, so reaching this is a deployment bug, not a caller's. Fail
  // exactly like every other verification failure rather than say so —
  // telling an unauthenticated caller why is free information.
  if (clientId === undefined) {
    throw new UnauthorizedError('Authentication failed');
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new UnauthorizedError('Authentication failed');
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
    throw new UnauthorizedError('Authentication failed');
  }

  // Only trust the header once the signature it names has been verified —
  // believing an unauthenticated `alg` is how "alg confusion" attacks work.
  // Pinning `RS256` also stops an attacker presenting an HS256 token signed
  // with the RSA public key treated as an HMAC secret, since that key is
  // public by design.
  const header = googleHeaderSchema.safeParse(parseJson(headerPart));
  if (!header.success) {
    throw new UnauthorizedError('Authentication failed');
  }

  const key = await importSigningKey(header.data.kid);
  if (key === undefined) {
    throw new UnauthorizedError('Authentication failed');
  }

  const signatureValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    decodeBase64Url(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!signatureValid) {
    throw new UnauthorizedError('Authentication failed');
  }

  const claims = googleClaimsSchema.safeParse(parseJson(payloadPart));
  if (!claims.success) {
    throw new UnauthorizedError('Authentication failed');
  }
  const data = claims.data;

  if (!GOOGLE_ID_TOKEN_ISSUERS.includes(data.iss)) {
    throw new UnauthorizedError('Authentication failed');
  }

  // Pinned as a literal so a token minted for a different Google client
  // cannot be replayed at this one.
  if (data.aud !== clientId) {
    throw new UnauthorizedError('Authentication failed');
  }

  if (clock.nowEpochSeconds() - JWT_CLOCK_LEEWAY_SECONDS >= data.exp) {
    throw new UnauthorizedError('Authentication failed');
  }

  if (!data.email_verified) {
    throw new UnauthorizedError('Authentication failed');
  }

  // The whole point of Google identity here: an address from outside the
  // charity's domain is refused even if it matches an account on file.
  if (data.hd !== GOOGLE_WORKSPACE_DOMAIN) {
    throw new UnauthorizedError('Authentication failed');
  }

  return data;
}

/**
 * Fetched fresh on every sign-in rather than cached. Google rotates these
 * keys infrequently and signing on happens at most a handful of times per
 * person per day, so the extra request costs nothing that matters and there
 * is no staleness window to reason about.
 */
async function importSigningKey(kid: string): Promise<CryptoKey | undefined> {
  const response = await fetch(GOOGLE_JWKS_URL);
  if (!response.ok) {
    return undefined;
  }

  const parsed = jwksSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    return undefined;
  }

  const jwk = parsed.data.keys.find((candidate) => candidate.kid === kid);
  if (jwk === undefined) {
    return undefined;
  }

  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

const jwksSchema = z.object({
  keys: z.array(
    z.object({
      kid: z.string(),
      kty: z.string(),
      n: z.string(),
      e: z.string(),
    }),
  ),
});

function parseJson(part: string): unknown {
  try {
    return JSON.parse(decodeBase64UrlText(part));
  } catch {
    return undefined;
  }
}
