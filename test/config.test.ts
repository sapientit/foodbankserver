import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.ts';

const SECRET = 'a-secret-that-is-at-least-32-characters';

describe('loadConfig', () => {
  it('applies defaults when only the secret is set', () => {
    expect(loadConfig({ AUTH_JWT_SECRET: SECRET })).toEqual({
      environment: 'development',
      logLevel: 'info',
      authMode: 'dummy',
      jwtSecret: SECRET,
      turnstileSecret: undefined,
      allowedOrigins: [],
      piiRetentionDays: undefined,
      isProduction: false,
    });
  });

  it('refuses to start without a signing secret', () => {
    expect(() => loadConfig({})).toThrow(/AUTH_JWT_SECRET/);
  });

  it('refuses a signing secret that is too short to be safe', () => {
    expect(() => loadConfig({ AUTH_JWT_SECRET: 'short' })).toThrow(/at least 32 characters/);
  });

  it('rejects an unknown environment', () => {
    expect(() => loadConfig({ AUTH_JWT_SECRET: SECRET, ENVIRONMENT: 'staging' })).toThrow(
      /ENVIRONMENT/,
    );
  });

  it('refuses to start when AUTH_MODE is dummy in production', () => {
    expect(() =>
      loadConfig({ AUTH_JWT_SECRET: SECRET, ENVIRONMENT: 'production', AUTH_MODE: 'dummy' }),
    ).toThrow(/AUTH_MODE=dummy is refused in production/);
  });

  it('accepts production with a real identity provider', () => {
    const config = loadConfig({
      AUTH_JWT_SECRET: SECRET,
      ENVIRONMENT: 'production',
      AUTH_MODE: 'google',
      // Production also refuses to start without a bot check on the open
      // referral endpoint — see hardening.test.ts.
      TURNSTILE_SECRET_KEY: 'turnstile-secret',
    });

    expect(config.isProduction).toBe(true);
    expect(config.authMode).toBe('google');
  });

  it('memoises per bindings object', () => {
    const bindings = { AUTH_JWT_SECRET: SECRET, ENVIRONMENT: 'test' };

    expect(loadConfig(bindings)).toBe(loadConfig(bindings));
  });
});
