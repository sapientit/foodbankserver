import { defineConfig } from 'drizzle-kit';

/**
 * Generates SQL migrations into `migrations/`, which is also where wrangler
 * reads them from (`migrations_dir` in wrangler.jsonc). One directory, one
 * source of truth — so the migrations the tests apply are exactly the ones
 * `wrangler d1 migrations apply` will run.
 */
export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/db/schema/index.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
