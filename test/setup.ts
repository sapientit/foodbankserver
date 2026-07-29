import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

/**
 * Applies every migration in `migrations/` before the suite runs, against the
 * same D1 binding the tests use. Storage isolation in this pool is per test
 * *file*, so this runs once per file and each file starts from the real,
 * fully-migrated schema.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
