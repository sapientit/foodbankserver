import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_SECONDS, JWT_CLOCK_LEEWAY_SECONDS } from '../src/config/constants.ts';
import { fixedClock } from '../src/core/clock.ts';
import { encodeBase64UrlText } from '../src/core/base64url.ts';
import { signAccessToken, verifyAccessToken } from '../src/modules/auth/token.service.ts';

const SECRET = 'a-secret-that-is-at-least-32-characters';
const SUBJECT = { userId: 'user-1', email: 'lead@example.org', role: 'team_lead' } as const;

describe('access tokens', () => {
  const clock = fixedClock('2026-08-04T09:00:00.000Z');

  it('round-trips its claims', async () => {
    const { token, expiresAt } = await signAccessToken(SUBJECT, SECRET, clock);
    const claims = await verifyAccessToken(token, SECRET, clock);

    expect(claims.sub).toBe('user-1');
    expect(claims.email).toBe('lead@example.org');
    expect(claims.role).toBe('team_lead');
    expect(claims.exp).toBe(clock.nowEpochSeconds() + ACCESS_TOKEN_TTL_SECONDS);
    expect(expiresAt).toBe(claims.exp);
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await signAccessToken(SUBJECT, SECRET, clock);

    await expect(
      verifyAccessToken(token, 'another-secret-of-at-least-32-characters', clock),
    ).rejects.toThrow(/Invalid access token/);
  });

  it('rejects a tampered payload', async () => {
    const { token } = await signAccessToken(SUBJECT, SECRET, clock);
    const [header, payload, signature] = token.split('.');

    // Promote the team lead to admin without re-signing.
    const decoded = JSON.parse(atob((payload ?? '').replaceAll('-', '+').replaceAll('_', '/'))) as {
      role: string;
    };
    decoded.role = 'admin';
    const forged = `${header ?? ''}.${encodeBase64UrlText(JSON.stringify(decoded))}.${signature ?? ''}`;

    await expect(verifyAccessToken(forged, SECRET, clock)).rejects.toThrow(/Invalid access token/);
  });

  it('rejects an expired token once past the clock leeway', async () => {
    const { token } = await signAccessToken(SUBJECT, SECRET, clock);
    const later = fixedClock('2026-08-04T09:16:01.000Z');

    // Still inside the leeway a moment earlier.
    const stillValid = fixedClock('2026-08-04T09:15:30.000Z');
    await expect(verifyAccessToken(token, SECRET, stillValid)).resolves.toBeDefined();

    await expect(verifyAccessToken(token, SECRET, later)).rejects.toThrow(/Invalid access token/);
    expect(ACCESS_TOKEN_TTL_SECONDS + JWT_CLOCK_LEEWAY_SECONDS).toBe(960);
  });

  it('rejects a token that is not a JWT at all', async () => {
    for (const bad of ['', 'nonsense', 'a.b', 'a.b.c.d']) {
      await expect(verifyAccessToken(bad, SECRET, clock)).rejects.toThrow(/Invalid access token/);
    }
  });

  it('rejects an unsigned "alg: none" token', async () => {
    const header = encodeBase64UrlText(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = encodeBase64UrlText(
      JSON.stringify({
        iss: 'foodbank-api',
        aud: 'foodbank-web',
        sub: 'user-1',
        email: 'attacker@example.org',
        role: 'admin',
        iat: clock.nowEpochSeconds(),
        exp: clock.nowEpochSeconds() + 3600,
        jti: 'x',
      }),
    );

    await expect(verifyAccessToken(`${header}.${payload}.`, SECRET, clock)).rejects.toThrow(
      /Invalid access token/,
    );
  });

  it('gives the same message whatever the failure, so probing learns nothing', async () => {
    const { token } = await signAccessToken(SUBJECT, SECRET, clock);
    const expired = fixedClock('2026-08-04T10:00:00.000Z');

    const messages = await Promise.all(
      [
        verifyAccessToken(token, SECRET, expired),
        verifyAccessToken(token, 'another-secret-of-at-least-32-characters', clock),
        verifyAccessToken('garbage', SECRET, clock),
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
