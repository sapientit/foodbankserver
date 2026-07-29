import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../src/core/errors.ts';
import { errorHandler, notFoundHandler } from '../src/http/error-handler.ts';
import type { AppEnv } from '../src/http/types.ts';
import { buildTestApp } from './helpers/app.ts';

describe('error handling', () => {
  it('maps an AppError to its own status and code', async () => {
    const testApp = buildTestApp();
    testApp.app.get('/boom', () => {
      throw new ConflictError('Pick list already confirmed');
    });

    const response = await testApp.request('/boom');

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'CONFLICT', message: 'Pick list already confirmed' },
    });
  });

  it('does not leak the message of an unexpected error', async () => {
    const testApp = buildTestApp();
    testApp.app.get('/boom', () => {
      throw new Error('connection string postgres://user:hunter2@host/db');
    });

    const response = await testApp.request('/boom');
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain('hunter2');
    expect(JSON.parse(body)).toMatchObject({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  });

  it('still returns a structured 500 when configuration is invalid', async () => {
    // A production deployment left on the dummy identity provider. `loadConfig`
    // throws inside the first middleware, so the error handler runs before the
    // request-scoped logger has been replaced with the configured one.
    const testApp = buildTestApp();
    const badEnv = { ...env, ENVIRONMENT: 'production', AUTH_MODE: 'dummy' };

    const response = await testApp.app.request('/health', {}, badEnv);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: expect.any(String),
      },
    });
    // Still traceable: the id is emitted even though config never loaded.
    expect(response.headers.get('x-request-id')).toEqual(expect.any(String));
  });

  it('reports the method and path of an unknown route', async () => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.notFound(notFoundHandler);

    const response = await app.request('/api/v1/sessions', { method: 'POST' }, env);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Route POST /api/v1/sessions not found' },
    });
  });

  it('carries structured details when an error supplies them', async () => {
    const testApp = buildTestApp();
    testApp.app.get('/boom', () => {
      throw new NotFoundError('Session not found', { details: { sessionId: 'abc' } });
    });

    const response = await testApp.request('/boom');

    expect(await response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', details: { sessionId: 'abc' } },
    });
  });
});
