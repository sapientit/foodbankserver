import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.ts';

describe('health routes', () => {
  const testApp = buildTestApp();

  it('reports ok without touching the database', async () => {
    const response = await testApp.request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', version: null });
  });

  it('reports the stamped commit as version', async () => {
    const stamped = buildTestApp({ bindings: { GIT_SHA: 'abc1234' } });

    const response = await stamped.request('/health');

    expect(await response.json()).toEqual({ status: 'ok', version: 'abc1234' });
  });

  it('reports ready when D1 answers', async () => {
    const response = await testApp.request('/ready');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('returns a structured error for an unknown route', async () => {
    const response = await testApp.request('/nope');

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', requestId: expect.any(String) },
    });
  });

  it('sets security headers and echoes a request id', async () => {
    const response = await testApp.request('/health');

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-request-id')).toEqual(expect.any(String));
  });
});
