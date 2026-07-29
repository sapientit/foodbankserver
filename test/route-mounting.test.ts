import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.ts';

/**
 * Guards against a mounting mistake that is easy to reintroduce and quiet when
 * it happens.
 *
 * Several sub-apps share the `/api/v1` prefix. A `use('*', requireAuth)` inside
 * any of them applies to every path under that prefix — not just the routes
 * that sub-app serves. The symptom is mild (404s become 401s) but the real
 * risk is the opposite direction: a public route mounted after an authenticated
 * sub-app would silently start demanding a token.
 */
describe('route mounting', () => {
  it('reports an unmatched API path as 404, not 401', async () => {
    const testApp = buildTestApp();

    const response = await testApp.request('/api/v1/nonexistent');

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('does not require authentication on public routes sharing the prefix', async () => {
    const testApp = buildTestApp();

    const response = await testApp.request('/api/v1/public/sessions');

    expect(response.status).toBe(200);
  });

  it('leaves health probes outside the API prefix untouched', async () => {
    const testApp = buildTestApp();

    expect((await testApp.request('/health')).status).toBe(200);
    expect((await testApp.request('/ready')).status).toBe(200);
  });

  it('still protects the routes that should be protected', async () => {
    const testApp = buildTestApp();

    for (const path of ['/api/v1/sessions', '/api/v1/recurring-sessions']) {
      expect((await testApp.request(path)).status).toBe(401);
    }
  });
});
