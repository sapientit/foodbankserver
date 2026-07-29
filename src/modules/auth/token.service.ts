import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_AUDIENCE,
  JWT_CLOCK_LEEWAY_SECONDS,
  JWT_ISSUER,
} from '../../config/constants.ts';
import {
  decodeBase64Url,
  decodeBase64UrlText,
  encodeBase64Url,
  encodeBase64UrlText,
} from '../../core/base64url.ts';
import { z } from 'zod';
import type { Clock } from '../../core/clock.ts';
import { UnauthorizedError } from '../../core/errors.ts';
import { USER_ROLES, type UserRole } from '../../db/schema/users.ts';

/**
 * Access tokens: stateless HS256 JWTs, signed and verified with WebCrypto.
 *
 * Stateless is a deliberate D1 decision. Verifying costs zero queries, and on
 * the free plan a Worker invocation gets only 50 — spending one on every
 * request just to authenticate would eat the budget the pick-list endpoints
 * need, and would make auth a bottleneck on exactly the wrong path.
 *
 * The trade-off is that revoking a user takes up to one token lifetime to
 * bite. Revoking their refresh family blocks renewal immediately, so the blast
 * radius is fifteen minutes.
 *
 * This module is pure: no database, no HTTP, no bindings.
 */

export interface AccessTokenClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly email: string;
  readonly role: UserRole;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface AccessTokenSubject {
  readonly userId: string;
  readonly email: string;
  readonly role: UserRole;
}

interface JwtHeader {
  readonly alg: 'HS256';
  readonly typ: 'JWT';
}

const HEADER: JwtHeader = { alg: 'HS256', typ: 'JWT' };

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signAccessToken(
  subject: AccessTokenSubject,
  secret: string,
  clock: Clock,
): Promise<{ token: string; expiresAt: number }> {
  const issuedAt = clock.nowEpochSeconds();
  const expiresAt = issuedAt + ACCESS_TOKEN_TTL_SECONDS;

  const claims: AccessTokenClaims = {
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    sub: subject.userId,
    email: subject.email,
    role: subject.role,
    iat: issuedAt,
    exp: expiresAt,
    jti: crypto.randomUUID(),
  };

  const payload = `${encodeBase64UrlText(JSON.stringify(HEADER))}.${encodeBase64UrlText(
    JSON.stringify(claims),
  )}`;

  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));

  return { token: `${payload}.${encodeBase64Url(new Uint8Array(signature))}`, expiresAt };
}

/**
 * Verifies signature, then issuer, audience and expiry.
 *
 * Every failure returns the same generic message. Telling a caller whether a
 * token was expired, forged or simply malformed is free information for
 * whoever is probing.
 */
export async function verifyAccessToken(
  token: string,
  secret: string,
  clock: Clock,
): Promise<AccessTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new UnauthorizedError('Invalid access token');
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
    throw new UnauthorizedError('Invalid access token');
  }

  const key = await importSigningKey(secret);
  const signatureValid = await crypto.subtle.verify(
    'HMAC',
    key,
    decodeBase64Url(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!signatureValid) {
    throw new UnauthorizedError('Invalid access token');
  }

  // Only trust the header once the signature is verified — believing an
  // unauthenticated `alg` value is how "alg: none" attacks work.
  const header = headerSchema.safeParse(parseJson(headerPart));
  if (!header.success) {
    throw new UnauthorizedError('Invalid access token');
  }

  // Issuer and audience are pinned as literals, so a token minted for a
  // different service cannot be replayed at this one.
  const claims = claimsSchema.safeParse(parseJson(payloadPart));
  if (!claims.success) {
    throw new UnauthorizedError('Invalid access token');
  }

  if (clock.nowEpochSeconds() - JWT_CLOCK_LEEWAY_SECONDS >= claims.data.exp) {
    throw new UnauthorizedError('Invalid access token');
  }

  return claims.data;
}

const headerSchema = z.object({ alg: z.literal('HS256') });

const claimsSchema = z.object({
  iss: z.literal(JWT_ISSUER),
  aud: z.literal(JWT_AUDIENCE),
  sub: z.string().min(1),
  email: z.string().min(1),
  role: z.enum(USER_ROLES),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(1),
});

function parseJson(part: string): unknown {
  try {
    return JSON.parse(decodeBase64UrlText(part));
  } catch {
    return undefined;
  }
}
