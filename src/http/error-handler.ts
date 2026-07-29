import { HTTPException } from 'hono/http-exception';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { isAppError } from '../core/errors.ts';
import { toSafeError, type Logger } from '../core/log.ts';
import type { AppEnv } from './types.ts';

/**
 * Single exit point for failures.
 *
 * Known `AppError`s report their own status and code. Everything else is
 * logged in full and reduced to an opaque 500, so stack traces, SQL and — most
 * importantly — anything a personal-data-bearing error message might contain
 * never reach a client.
 */

export interface ErrorResponseBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly requestId: string;
  };
}

export const errorHandler: ErrorHandler<AppEnv> = (error, c) => {
  const requestId = safeRequestId(c);
  const log = safeLogger(c);

  if (isAppError(error)) {
    log.info('request rejected', { code: error.code, statusCode: error.statusCode });
    return c.json<ErrorResponseBody>(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
          requestId,
        },
      },
      error.statusCode as ContentfulStatus,
    );
  }

  // Hono's own failures: malformed JSON, payload limits, aborted requests.
  if (error instanceof HTTPException && error.status < 500) {
    log.info('request rejected', { statusCode: error.status });
    return c.json<ErrorResponseBody>(
      {
        error: { code: 'BAD_REQUEST', message: error.message, requestId },
      },
      error.status,
    );
  }

  log.error('unhandled error', { error: toSafeError(error) });
  return c.json<ErrorResponseBody>(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId,
      },
    },
    500,
  );
};

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) => {
  return c.json<ErrorResponseBody>(
    {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${c.req.method} ${new URL(c.req.url).pathname} not found`,
        requestId: safeRequestId(c),
      },
    },
    404,
  );
};

/**
 * `requestContext` sets the request id and a bootstrap logger before anything
 * that can throw, so both are always present here — including when the failure
 * being handled is invalid configuration. That ordering is load-bearing:
 * without it this handler would throw while handling an error and turn a clear
 * 500 into a hung socket.
 */
function safeRequestId(c: Context<AppEnv>): string {
  return c.get('requestId');
}

function safeLogger(c: Context<AppEnv>): Logger {
  return c.get('logger');
}

/** Hono types `c.json`'s status as the subset that may carry a body. */
type ContentfulStatus = Parameters<Context['json']>[1] & number;
