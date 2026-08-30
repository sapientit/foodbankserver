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
      smsSimulate: false,
      smsLiveNumber: undefined,
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
      SMS_WEBHOOK_SECRET: 'sms-webhook-secret-long-enough',
    });

    expect(config.isProduction).toBe(true);
    expect(config.authMode).toBe('google');
  });

  it('refuses production with an unguarded SMS webhook', () => {
    // The webhook is the second unauthenticated write in the system and the
    // only one that lands in `sms_messages`. Without the secret anybody could
    // post a household's supposed reply into it.
    expect(() =>
      loadConfig({
        AUTH_JWT_SECRET: SECRET,
        ENVIRONMENT: 'production',
        AUTH_MODE: 'google',
        TURNSTILE_SECRET_KEY: 'turnstile-secret',
      }),
    ).toThrow(/SMS_WEBHOOK_SECRET is required in production/);
  });

  it('refuses production with the dev/test SMS simulator turned on', () => {
    // A real deployment must never silently pretend to text a household.
    expect(() =>
      loadConfig({
        AUTH_JWT_SECRET: SECRET,
        ENVIRONMENT: 'production',
        AUTH_MODE: 'google',
        TURNSTILE_SECRET_KEY: 'turnstile-secret',
        SMS_WEBHOOK_SECRET: 'sms-webhook-secret-long-enough',
        SMS_SIMULATE: 'true',
      }),
    ).toThrow(/SMS_SIMULATE is refused in production/);
  });

  it('refuses production with SMS_LIVE_NUMBER set at all', () => {
    // Restricting real sends to one number in production would mean the food
    // bank silently not texting most of its households.
    expect(() =>
      loadConfig({
        AUTH_JWT_SECRET: SECRET,
        ENVIRONMENT: 'production',
        AUTH_MODE: 'google',
        TURNSTILE_SECRET_KEY: 'turnstile-secret',
        SMS_WEBHOOK_SECRET: 'sms-webhook-secret-long-enough',
        SMS_LIVE_NUMBER: '07700 900123',
      }),
    ).toThrow(/SMS_LIVE_NUMBER is refused in production/);
  });

  it('refuses an SMS_LIVE_NUMBER that does not normalise as a UK number, in any environment', () => {
    // Comparison at send time is by `phonesMatch`, which quietly returns false
    // for anything unparseable — a typo here must not boot into a "live"
    // number that can then never actually match.
    expect(() =>
      loadConfig({
        AUTH_JWT_SECRET: SECRET,
        SMS_LIVE_NUMBER: 'not-a-phone-number',
      }),
    ).toThrow(/SMS_LIVE_NUMBER must be a recognisable UK number/);
  });

  it('memoises per bindings object', () => {
    const bindings = { AUTH_JWT_SECRET: SECRET, ENVIRONMENT: 'test' };

    expect(loadConfig(bindings)).toBe(loadConfig(bindings));
  });
});
