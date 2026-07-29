import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests run inside real workerd against a real Miniflare-backed SQLite, so
 * CHECK constraints, partial unique indexes, `batch()` atomicity and
 * `json_each` all behave exactly as they will in production. A mocked
 * repository would prove none of that.
 *
 * The migrations are read here and applied in `test/setup.ts`, which makes the
 * migrations themselves self-testing: a broken one fails the suite rather than
 * production.
 */
const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/worker.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        d1Databases: ['DB'],
        bindings: {
          TEST_MIGRATIONS: migrations,
          ENVIRONMENT: 'test',
          LOG_LEVEL: 'silent',
          AUTH_MODE: 'dummy',
          AUTH_JWT_SECRET: 'test-signing-secret-at-least-32-chars-long',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    coverage: {
      // V8 coverage is not supported inside workerd.
      provider: 'istanbul',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/worker.ts', 'src/db/schema/**'],
    },
  },
});
