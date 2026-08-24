import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

/**
 * Applies every migration in `migrations/` before the suite runs, against the
 * same D1 binding the tests use. Storage isolation in this pool is per test
 * *file*, so this runs once per file and each file starts from the real,
 * fully-migrated schema.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// `.dev.vars` is loaded into `env` the same way `wrangler dev` loads it, so a
// real (or test) Turnstile secret kept there for local dev leaks into every
// `buildTestApp()` call. `requireTurnstile` only skips when the secret is
// genuinely `undefined`, and the suite relies on that default — every test
// that wants the check enabled sets `TURNSTILE_SECRET_KEY` explicitly via
// `buildTestApp({ bindings: { ... } })` (see `hardening.test.ts`). Strip it
// here so `.dev.vars` can carry Cloudflare's dummy key for `wrangler dev`
// without silently enabling the check for every other test.
Reflect.deleteProperty(env, 'TURNSTILE_SECRET_KEY');
