import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_ID_TOKEN_ISSUERS,
  GOOGLE_JWKS_URL,
  JWT_CLOCK_LEEWAY_SECONDS,
} from '../src/config/constants.ts';
import { loadConfig, type AppConfig } from '../src/config/env.ts';
import { decodeBase64UrlText, encodeBase64UrlText } from '../src/core/base64url.ts';
import { fixedClock, type Clock } from '../src/core/clock.ts';
import { createGoogleProvider } from '../src/modules/auth/providers/google-provider.ts';
import {
  GOOGLE_TEST_CLIENT_ID,
  GOOGLE_TEST_KID,
  GOOGLE_TEST_WORKSPACE_DOMAIN,
  defaultGoogleClaims,
  generateGoogleTestKeyPair,
  googleJwksBody,
  jsonResponse,
  signGoogleIdToken,
  signGoogleTokenParts,
  type GoogleTestKeyPair,
} from './helpers/google-token.ts';

const SECRET = 'test-signing-secret-at-least-32-chars-long';
const AUTH_FAILED = /Authentication failed/;
const CLOCK = fixedClock('2026-08-04T09:00:00.000Z');

/** A real `AppConfig`, produced the same way production config is, rather than a hand-built stub. */
function configWithClientId(clientId: string | undefined): AppConfig {
  return clientId === undefined
    ? loadConfig({ AUTH_JWT_SECRET: SECRET })
    : loadConfig({ AUTH_JWT_SECRET: SECRET, AUTH_MODE: 'google', GOOGLE_AUTH_CLIENT_ID: clientId });
}

function provider(clock: Clock, clientId: string = GOOGLE_TEST_CLIENT_ID) {
  return createGoogleProvider(configWithClientId(clientId), clock);
}

/**
 * Separate from `provider()` rather than passed `undefined` for it: a default
 * parameter fires on an explicit `undefined` argument too, which would quietly
 * turn "no client id configured" back into the default client id.
 */
function providerWithNoClientId(clock: Clock) {
  return createGoogleProvider(configWithClientId(undefined), clock);
}

let keyPair: GoogleTestKeyPair;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  keyPair = await generateGoogleTestKeyPair();
});

beforeEach(() => {
  // A fresh `Response` per call, not `mockResolvedValue` with one shared
  // instance: a `Response` body can only be read once, and more than one test
  // here calls `authenticate()` several times against the same mock.
  fetchMock = vi.fn(() => Promise.resolve(jsonResponse(googleJwksBody(keyPair))));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createGoogleProvider', () => {
  it('accepts a valid token from the charity’s Workspace domain', async () => {
    const token = await signGoogleIdToken(
      keyPair.privateKey,
      defaultGoogleClaims(CLOCK.nowEpochSeconds()),
    );

    const claim = await provider(CLOCK).authenticate({ idToken: token });

    expect(claim).toEqual({
      provider: 'google',
      subject: 'google-subject-1',
      email: 'pete@guildfordfoodbank.org',
      emailVerified: true,
      displayName: 'Pete Bennett',
    });
  });

  it('falls back to the email as the display name when Google sends no name claim', async () => {
    const { name: _name, ...withoutName } = defaultGoogleClaims(CLOCK.nowEpochSeconds());
    const token = await signGoogleIdToken(keyPair.privateKey, withoutName);

    const claim = await provider(CLOCK).authenticate({ idToken: token });

    expect(claim.displayName).toBe('pete@guildfordfoodbank.org');
  });

  it('fetches Google’s published JWKS to verify the signature', async () => {
    const token = await signGoogleIdToken(
      keyPair.privateKey,
      defaultGoogleClaims(CLOCK.nowEpochSeconds()),
    );

    await provider(CLOCK).authenticate({ idToken: token });

    expect(fetchMock).toHaveBeenCalledWith(GOOGLE_JWKS_URL);
  });

  it('rejects any header alg other than RS256 before ever fetching the JWKS', async () => {
    const claims = defaultGoogleClaims(CLOCK.nowEpochSeconds());

    for (const alg of ['HS256', 'none']) {
      const header = encodeBase64UrlText(JSON.stringify({ alg, kid: GOOGLE_TEST_KID }));
      const payload = encodeBase64UrlText(JSON.stringify(claims));
      const token = `${header}.${payload}.forged-signature`;

      await expect(provider(CLOCK).authenticate({ idToken: token })).rejects.toThrow(AUTH_FAILED);
    }

    // The algorithm-confusion defence: an unverified `alg` is never trusted
    // enough to even go looking for a key.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a token that is not three dot-separated parts', async () => {
    // An empty string is refused earlier, by `googleLoginSchema`'s own
    // `.min(1)` — a request validation failure, not an authentication one —
    // so it is deliberately not one of these.
    for (const bad of ['nonsense', 'a.b', 'a.b.c.d']) {
      await expect(provider(CLOCK).authenticate({ idToken: bad })).rejects.toThrow(AUTH_FAILED);
    }
  });

  it('rejects a token whose header is not valid base64url JSON', async () => {
    const header = encodeBase64UrlText('not-json-at-all');
    const payload = encodeBase64UrlText(
      JSON.stringify(defaultGoogleClaims(CLOCK.nowEpochSeconds())),
    );
    const token = `${header}.${payload}.forged-signature`;

    await expect(provider(CLOCK).authenticate({ idToken: token })).rejects.toThrow(AUTH_FAILED);
  });

  it('rejects a token whose payload is not valid base64url JSON', async () => {
    const header = encodeBase64UrlText(JSON.stringify({ alg: 'RS256', kid: GOOGLE_TEST_KID }));
    const payload = encodeBase64UrlText('not-json-at-all');
    const token = await signGoogleTokenParts(keyPair.privateKey, header, payload);

    await expect(provider(CLOCK).authenticate({ idToken: token })).rejects.toThrow(AUTH_FAILED);
  });

  it('rejects a token whose payload was tampered with after signing', async () => {
    const token = await signGoogleIdToken(
      keyPair.privateKey,
      defaultGoogleClaims(CLOCK.nowEpochSeconds()),
    );
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(decodeBase64UrlText(payload ?? '')) as Record<string, unknown>;
    decoded.email = 'attacker@guildfordfoodbank.org';
    const forged = `${header ?? ''}.${encodeBase64UrlText(JSON.stringify(decoded))}.${signature ?? ''}`;

    await expect(provider(CLOCK).authenticate({ idToken: forged })).rejects.toThrow(AUTH_FAILED);
  });

  it('rejects a token whose kid is not in the fetched JWKS', async () => {
    const token = await signGoogleIdToken(
      keyPair.privateKey,
      defaultGoogleClaims(CLOCK.nowEpochSeconds()),
      { kid: 'a-kid-nobody-published' },
    );

    await expect(provider(CLOCK).authenticate({ idToken: token })).rejects.toThrow(AUTH_FAILED);
  });

  it('rejects a token when the JWKS fetch itself fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const token = await signGoogleIdToken(
      keyPair.privateKey,
      defaultGoogleClaims(CLOCK.nowEpochSeconds()),
    );

    await expect(provider(CLOCK).authenticate({ idToken: token })).rejects.toThrow(AUTH_FAILED);
  });

  it('rejects a token whose audience does not match the configured client id', async () => {
    const token = await signGoogleIdToken(keyPair.privateKey, {
      ...defaultGoogleClaims(CLOCK.nowEpochSeconds()),
      aud: 'someone-elses-client-id.apps.googleusercontent.com',
    });

    await expect(provider(CLOCK).authenticate({ idToken: token })).rejects.toThrow(AUTH_FAILED);
  });

  it('rejects a token when no Google client id is configured', async () => {
    const token = await signGoogleIdToken(
      keyPair.privateKey,
      defaultGoogleClaims(CLOCK.nowEpochSeconds()),
    );

    await expect(providerWithNoClientId(CLOCK).authenticate({ idToken: token })).rejects.toThrow(
      AUTH_FAILED,
    );
    // Refused before ever looking anything up — this is a deployment bug,
    // not a signal to go verify a signature over.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(GOOGLE_ID_TOKEN_ISSUERS)('accepts the %s issuer', async (iss) => {
    const token = await signGoogleIdToken(keyPair.privateKey, {
      ...defaultGoogleClaims(CLOCK.nowEpochSeconds()),
      iss,
    });

    await expect(provider(CLOCK).authenticate({ idToken: token })).resolves.toBeDefined();
  });

  it('rejects a token from an issuer other than Google', async () => {
    const token = await signGoogleIdToken(keyPair.privateKey, {
      ...defaultGoogleClaims(CLOCK.nowEpochSeconds()),
      iss: 'https://not-google.example.com',
    });

    await expect(provider(CLOCK).authenticate({ idToken: token })).rejects.toThrow(AUTH_FAILED);
  });

  it('accepts a token within the clock leeway after it expires, and rejects one further past it', async () => {
    const exp = CLOCK.nowEpochSeconds() + 3600;
    const token = await signGoogleIdToken(keyPair.privateKey, {
      ...defaultGoogleClaims(CLOCK.nowEpochSeconds()),
      exp,
    });

    // Still inside the leeway a moment before it runs out.
    const stillValid = fixedClock(
      new Date((exp + JWT_CLOCK_LEEWAY_SECONDS - 5) * 1000).toISOString(),
    );
    await expect(provider(stillValid).authenticate({ idToken: token })).resolves.toBeDefined();

    const later = fixedClock(new Date((exp + JWT_CLOCK_LEEWAY_SECONDS + 1) * 1000).toISOString());
    await expect(provider(later).authenticate({ idToken: token })).rejects.toThrow(AUTH_FAILED);
  });

  it('rejects a token whose email is not verified', async () => {
    const token = await signGoogleIdToken(keyPair.privateKey, {
      ...defaultGoogleClaims(CLOCK.nowEpochSeconds()),
      email_verified: false,
    });

    await expect(provider(CLOCK).authenticate({ idToken: token })).rejects.toThrow(AUTH_FAILED);
  });

  it('rejects a token with no hd claim, as an ordinary Gmail address would present', async () => {
    const { hd: _hd, ...withoutHd } = defaultGoogleClaims(CLOCK.nowEpochSeconds());
    const token = await signGoogleIdToken(keyPair.privateKey, withoutHd);

    await expect(provider(CLOCK).authenticate({ idToken: token })).rejects.toThrow(AUTH_FAILED);
  });

  it('rejects a token whose hd claim is a different domain', async () => {
    expect(GOOGLE_TEST_WORKSPACE_DOMAIN).toBe('guildfordfoodbank.org');
    const token = await signGoogleIdToken(keyPair.privateKey, {
      ...defaultGoogleClaims(CLOCK.nowEpochSeconds()),
      hd: 'a-different-charity.org',
    });

    await expect(provider(CLOCK).authenticate({ idToken: token })).rejects.toThrow(AUTH_FAILED);
  });

  it('gives the same message whatever the failure, so probing learns nothing', async () => {
    const validToken = await signGoogleIdToken(
      keyPair.privateKey,
      defaultGoogleClaims(CLOCK.nowEpochSeconds()),
    );
    const wrongDomainToken = await signGoogleIdToken(keyPair.privateKey, {
      ...defaultGoogleClaims(CLOCK.nowEpochSeconds()),
      hd: 'a-different-charity.org',
    });

    const messages = await Promise.all(
      [
        provider(CLOCK).authenticate({ idToken: 'not-a-jwt' }),
        provider(CLOCK).authenticate({ idToken: wrongDomainToken }),
        provider(CLOCK, 'a-different-client-id').authenticate({ idToken: validToken }),
      ].map((promise) =>
        promise.then(
          () => 'resolved',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      ),
    );

    expect(new Set(messages).size).toBe(1);
  });
});
