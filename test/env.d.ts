import type { D1Migration } from '@cloudflare/vitest-pool-workers';

/**
 * `cloudflare:test` types `env` as `Cloudflare.Env`, so the test-only bindings
 * declared in vitest.config.ts are merged in here rather than polluting the
 * generated `worker-configuration.d.ts`.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
