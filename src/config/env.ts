import { z } from 'zod';

/**
 * Configuration comes from Worker bindings, not `process.env` — there is no
 * process on Workers. This is the only module that reads raw bindings; every
 * other module receives a validated `AppConfig`, so the full set of
 * configuration inputs is declared in one schema.
 */

const configSchema = z
  .object({
    ENVIRONMENT: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    AUTH_MODE: z.enum(['dummy', 'google']).default('dummy'),
    /**
     * HMAC key for access tokens. A Worker secret, never a var — it must not
     * appear in wrangler.jsonc. Deliberately has no default: a missing signing
     * key must stop the Worker, not silently produce forgeable tokens.
     */
    AUTH_JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),

    /**
     * Turnstile secret for the unauthenticated referral form. Optional in
     * development so the form can be exercised without a widget; **required in
     * production**, because that endpoint is an open write storing names and
     * addresses.
     */
    TURNSTILE_SECRET_KEY: z.string().min(1).optional(),

    /**
     * Comma-separated origins the browser app is served from. Empty means
     * same-origin only, which is the safest default and correct if the
     * frontend ships as Workers static assets.
     */
    ALLOWED_ORIGINS: z.string().default(''),

    /**
     * Days after which a referral's personal data is purged. **Unset means the
     * purge never runs** — the charity has not set a retention period yet, and
     * guessing one would be worse than doing nothing.
     */
    PII_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).optional(),
  })
  .superRefine((value, ctx) => {
    // The dummy provider accepts any email address and issues a real admin
    // token. Booting with it in production would be an open admin panel over
    // real names, addresses and referral reasons — so refuse to start rather
    // than start insecurely.
    if (value.ENVIRONMENT === 'production' && value.AUTH_MODE === 'dummy') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: 'AUTH_MODE=dummy is refused in production. Set AUTH_MODE=google.',
      });
    }

    // The referral endpoint is unauthenticated and stores personal data. Going
    // to production without a bot check is not a configuration choice.
    if (value.ENVIRONMENT === 'production' && value.TURNSTILE_SECRET_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURNSTILE_SECRET_KEY'],
        message: 'TURNSTILE_SECRET_KEY is required in production.',
      });
    }
  });

type RawConfig = z.infer<typeof configSchema>;

export interface AppConfig {
  readonly environment: RawConfig['ENVIRONMENT'];
  readonly logLevel: RawConfig['LOG_LEVEL'];
  readonly authMode: RawConfig['AUTH_MODE'];
  readonly jwtSecret: string;
  readonly turnstileSecret: string | undefined;
  readonly allowedOrigins: readonly string[];
  readonly piiRetentionDays: number | undefined;
  readonly isProduction: boolean;
}

/**
 * Validation is per-isolate, not per-request. A Worker isolate handles many
 * requests with the same bindings object, and re-parsing on every one of them
 * would be pure waste on the hot path.
 */
const cache = new WeakMap<object, AppConfig>();

export function loadConfig(bindings: object): AppConfig {
  const cached = cache.get(bindings);
  if (cached !== undefined) return cached;

  const result = configSchema.safeParse(bindings);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${detail}`);
  }

  const config: AppConfig = {
    environment: result.data.ENVIRONMENT,
    logLevel: result.data.LOG_LEVEL,
    authMode: result.data.AUTH_MODE,
    jwtSecret: result.data.AUTH_JWT_SECRET,
    turnstileSecret: result.data.TURNSTILE_SECRET_KEY,
    allowedOrigins: result.data.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
    piiRetentionDays: result.data.PII_RETENTION_DAYS,
    isProduction: result.data.ENVIRONMENT === 'production',
  };

  cache.set(bindings, config);
  return config;
}
