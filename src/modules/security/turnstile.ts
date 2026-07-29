import { BadRequestError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const TURNSTILE_HEADER = 'cf-turnstile-response';

export interface TurnstileResult {
  readonly ok: boolean;
  readonly errorCodes: string[];
}

/**
 * Server-side Turnstile verification for the unauthenticated referral form.
 *
 * Three things worth knowing, all from the Cloudflare docs and all easy to get
 * wrong:
 *
 * - **A token can be validated only once.** A replay is rejected with
 *   `timeout-or-duplicate`, so this must be called exactly once per submission
 *   and never as part of a retry loop.
 * - **Tokens expire after 300 seconds.** A referrer who fills the form in
 *   slowly will fail; that is a real message the frontend has to handle, not
 *   an edge case.
 * - `idempotency_key` makes a *network* retry of the verification itself safe,
 *   which is different from retrying the submission.
 */
export async function verifyTurnstile(
  token: string,
  secret: string,
  options: { remoteIp?: string | undefined; idempotencyKey?: string | undefined } = {},
): Promise<TurnstileResult> {
  const body = {
    secret,
    response: token,
    ...(options.remoteIp === undefined ? {} : { remoteip: options.remoteIp }),
    ...(options.idempotencyKey === undefined ? {} : { idempotency_key: options.idempotencyKey }),
  };

  const response = await fetch(SITEVERIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return { ok: false, errorCodes: ['siteverify-unavailable'] };
  }

  const parsed: unknown = await response.json();
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, errorCodes: ['siteverify-malformed'] };
  }

  const result = parsed as { success?: unknown; 'error-codes'?: unknown };
  const errorCodes = Array.isArray(result['error-codes'])
    ? result['error-codes'].filter((code): code is string => typeof code === 'string')
    : [];

  return { ok: result.success === true, errorCodes };
}

/**
 * Enforces the check when a secret is configured, and skips it when not.
 *
 * Skipping is safe because `config/env.ts` refuses to start in production
 * without the secret — so "not configured" can only mean development.
 */
export async function requireTurnstile(input: {
  readonly secret: string | undefined;
  readonly token: string | undefined;
  readonly remoteIp: string | undefined;
  readonly requestId: string;
  readonly logger: Logger;
}): Promise<void> {
  if (input.secret === undefined) return;

  if (input.token === undefined || input.token.trim() === '') {
    throw new BadRequestError('This form needs its bot check completed before it can be sent');
  }

  const result = await verifyTurnstile(input.token, input.secret, {
    remoteIp: input.remoteIp,
    idempotencyKey: input.requestId,
  });

  if (!result.ok) {
    // Error codes are Cloudflare's own vocabulary and carry no personal data,
    // so they are safe to log and genuinely useful when a referrer is stuck.
    input.logger.warn('turnstile verification failed', { reason: result.errorCodes.join(',') });

    throw new BadRequestError(
      result.errorCodes.includes('timeout-or-duplicate')
        ? 'That bot check has expired. Please refresh the page and try again.'
        : 'The bot check could not be verified. Please try again.',
    );
  }
}
