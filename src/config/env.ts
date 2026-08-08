import { z } from 'zod';

/**
 * Configuration comes from Worker bindings, not `process.env` — there is no
 * process on Workers. This is the only module that reads raw bindings; every
 * other module receives a validated `AppConfig`, so the full set of
 * configuration inputs is declared in one schema.
 */

/**
 * A `var` declared in `wrangler.jsonc` but left blank means "not set yet".
 *
 * Removing the key instead would be the obvious way to say that, and it is
 * the wrong one: `wrangler types --strict-vars` generates the binding type
 * from the keys present, so a var declared in one environment and absent in
 * another types as a `string` that is actually `undefined` at runtime. Keeping
 * the key and treating blank as unset keeps the generated types honest, and
 * leaves the production placeholder visible to whoever has to fill it in.
 *
 * `.min(1)` would refuse to boot on a blank placeholder, which is the last
 * thing an optional feature should do to a deployment.
 */
const blankIsUnset = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? undefined : value));

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

    /**
     * TheSMSWorks credentials. Worker secrets, never vars.
     *
     * `SMS_API_KEY` is the provider's JWT; it does not expire, so treat it as
     * a long-lived secret and rotate it deliberately. `SMS_SENDER` is the
     * dedicated reply number households see and text back to — an alphanumeric
     * sender ID would look tidier and **cannot receive replies**, which would
     * make half the feature dead code.
     *
     * All three are optional so development and CI run without an account:
     * with no key, sending reports every household as a failure rather than
     * pretending. The production tripwire below is what stops that shipping.
     */
    SMS_API_KEY: z.string().min(1).optional(),
    SMS_SENDER: z.string().min(1).max(20).optional(),
    /**
     * The credentials TheSMSWorks presents on the inbound webhook, as
     * `user:password`. That route is public and writes personal data, so an
     * unset secret in production would be an open write into the most
     * sensitive table in the system.
     */
    SMS_WEBHOOK_SECRET: z.string().min(16).optional(),

    /**
     * The spreadsheet extract's two settings. **Neither is a secret and
     * neither is a credential**, because the server does not have one: the
     * administrator's browser obtains Google consent against their own Google
     * account and does the writing itself. There is no service account here
     * and there must not be one — that design was built and deliberately
     * replaced. See `INITIAL_SPEC1.txt`, `#Sending referrals to the
     * spreadsheet`.
     *
     * Both are plain `vars` in `wrangler.jsonc` with **different values per
     * environment**, so a test deployment writes to a test spreadsheet and
     * cannot touch the charity's real one.
     *
     * Both optional so development and CI boot without them, and there is
     * deliberately **no production tripwire**: unlike Turnstile or the SMS
     * webhook secret, an unconfigured extract is a closed feature reporting
     * itself closed, not an open door.
     */
    GOOGLE_SHEETS_SPREADSHEET_ID: blankIsUnset,
    /** The public OAuth client id the browser asks for Sheets consent against. */
    GOOGLE_OAUTH_CLIENT_ID: blankIsUnset,
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

    // The SMS webhook is the second unauthenticated write in the system and
    // the only one that lands in `sms_messages`. Without the secret it would
    // accept anything anybody posted at it.
    if (value.ENVIRONMENT === 'production' && value.SMS_WEBHOOK_SECRET === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_WEBHOOK_SECRET'],
        message: 'SMS_WEBHOOK_SECRET is required in production.',
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
  readonly smsApiKey: string | undefined;
  readonly smsSender: string | undefined;
  readonly smsWebhookSecret: string | undefined;
  readonly googleSpreadsheetId: string | undefined;
  readonly googleOauthClientId: string | undefined;
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
    smsApiKey: result.data.SMS_API_KEY,
    smsSender: result.data.SMS_SENDER,
    smsWebhookSecret: result.data.SMS_WEBHOOK_SECRET,
    googleSpreadsheetId: result.data.GOOGLE_SHEETS_SPREADSHEET_ID,
    googleOauthClientId: result.data.GOOGLE_OAUTH_CLIENT_ID,
    isProduction: result.data.ENVIRONMENT === 'production',
  };

  cache.set(bindings, config);
  return config;
}
