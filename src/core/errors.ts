/**
 * Domain and application errors.
 *
 * Throwing one of these is how a service reports a failure that the client
 * caused. Anything else that escapes a handler is a bug and is reported to the
 * client as a generic 500 — see `src/plugins/error-handler.ts`.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'NEW_CLIENTS_ASSIGNED';

export interface AppErrorOptions {
  readonly cause?: unknown;
  /** Safe to send to the client. Never put personal data in here. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, statusCode: number, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super('BAD_REQUEST', 400, message, options);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super('VALIDATION_FAILED', 400, message, options);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', options?: AppErrorOptions) {
    super('UNAUTHORIZED', 401, message, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Not permitted', options?: AppErrorOptions) {
    super('FORBIDDEN', 403, message, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super('NOT_FOUND', 404, message, options);
  }
}

/** The request is well-formed but conflicts with current state (e.g. a session already confirmed). */
export class ConflictError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super('CONFLICT', 409, message, options);
  }
}

/** A domain rule forbids the transition (e.g. not enough stock to pick a parcel). */
export class UnprocessableError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super('UNPROCESSABLE', 422, message, options);
  }
}

/**
 * A household is on the session but has not been picked for, so it has no
 * pick number to print. A `CONFLICT`, but a client needs to tell this apart
 * from every other 409 to explain *why* the listener sheet is refused rather
 * than just that it is — hence its own code instead of `ConflictError`.
 */
export class NewClientsAssignedError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super('NEW_CLIENTS_ASSIGNED', 409, message, options);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
