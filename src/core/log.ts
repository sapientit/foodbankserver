/**
 * Structured logging that cannot accept personal data.
 *
 * Referrals hold names, addresses, phone numbers and a reason for needing
 * food. Workers Logs are NOT pinned to the EU jurisdiction the D1 database is
 * pinned to, so logging personal data is a compliance failure, not merely
 * untidy. There is no redaction backstop on Workers.
 *
 * The defence is the type system: `LogContext` enumerates every field that may
 * be logged, and they are all identifiers or counts. Passing an entity —
 * `log.info('saved', { referral })` — is a compile error, not an incident.
 * Adding a field here is a deliberate decision to be reviewed against the PII
 * rules in CLAUDE.md.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LogContext {
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly statusCode?: number;
  readonly durationMs?: number;

  readonly userId?: string;
  readonly actorRole?: string;
  readonly actorKind?: string;

  readonly referralId?: string;
  readonly sessionId?: string;
  readonly recurringSessionId?: string;
  readonly pickListId?: string;
  readonly parcelId?: string;
  readonly stockItemId?: string;
  readonly purchaseId?: string;
  readonly stockTakeId?: string;
  readonly formDefinitionId?: string;
  readonly ruleSetId?: string;

  readonly jobName?: string;
  readonly count?: number;
  readonly code?: string;
  readonly reason?: string;

  readonly error?: SafeError;
}

/**
 * An error reduced to what is safe to emit.
 *
 * `message` is included because it is usually the only way to diagnose a
 * failure — which is exactly why no error message may ever be constructed from
 * personal data. See `core/errors.ts`.
 */
export interface SafeError {
  readonly name: string;
  readonly message: string;
  /** The underlying cause, also redacted. Usually where the real reason is. */
  readonly cause?: string;
  readonly stack?: string;
}

/**
 * Drizzle reports a failed query as
 * `Failed query: insert into "referrals" (…)\nparams: Jane Smith,12 High St,07700…`
 *
 * The SQL text is harmless and useful. **The bound parameters are the row** —
 * on `referrals` that is a referee's name, address and phone number. Since
 * unhandled errors are logged in full and Workers Logs are not EU-pinned,
 * letting that through would be a data-protection failure, not untidiness.
 */
export function redactQueryParams(message: string): string {
  const index = message.search(/\bparams:/);
  return index === -1 ? message : `${message.slice(0, index)}params: [redacted]`;
}

export function toSafeError(error: unknown): SafeError {
  if (!(error instanceof Error)) {
    return { name: 'UnknownError', message: redactQueryParams(String(error)) };
  }

  const cause = (error as Error & { cause?: unknown }).cause;

  return {
    name: error.name,
    message: redactQueryParams(error.message),
    ...(cause instanceof Error ? { cause: redactQueryParams(cause.message) } : {}),
    ...(error.stack === undefined ? {} : { stack: redactQueryParams(error.stack) }),
  };
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger that merges `base` into every record it writes. */
  child(base: LogContext): Logger;
}

export function createLogger(level: LogLevel | 'silent', base: LogContext = {}): Logger {
  const threshold = LEVEL_RANK[level];

  const write = (recordLevel: LogLevel, message: string, context: LogContext = {}): void => {
    if (LEVEL_RANK[recordLevel] < threshold) return;

    const record = {
      level: recordLevel,
      message,
      ...base,
      ...context,
    };

    // The single permitted use of console in the codebase: on Workers this is
    // the transport into Workers Logs. Everything else must go through Logger.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(record));
  };

  return {
    debug: (message, context) => {
      write('debug', message, context);
    },
    info: (message, context) => {
      write('info', message, context);
    },
    warn: (message, context) => {
      write('warn', message, context);
    },
    error: (message, context) => {
      write('error', message, context);
    },
    child: (childBase) => createLogger(level, { ...base, ...childBase }),
  };
}
