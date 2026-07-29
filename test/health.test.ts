import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.ts';

describe('health routes', () => {
  const testApp = buildTestApp();

  it('reports ok without touching the database', async () => {
    const response = await testApp.request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
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
