import { sha256Hex } from '../../core/crypto/tokens.ts';
import { UnauthorizedError } from '../../core/errors.ts';

/**
 * Verifies the HTTP Basic credentials TheSMSWorks presents on the inbound
 * webhook against the configured shared secret.
 *
 * `SMS_WEBHOOK_SECRET` is the whole `user:password` string, matched exactly
 * against what Basic auth decodes to — see `config/env.ts`.
 *
 * Modelled on `requireTurnstile`: skipped entirely when no secret is
 * configured. That is safe because `config/env.ts` refuses to start in
 * production without one, so "not configured" can only mean development.
 */
export async function requireWebhookAuth(input: {
  readonly secret: string | undefined;
  readonly authorizationHeader: string | undefined;
}): Promise<void> {
  if (input.secret === undefined) return;

  const presented = decodeBasicCredentials(input.authorizationHeader);
  if (presented === null || !(await credentialsMatch(presented, input.secret))) {
    throw new UnauthorizedError('Webhook authentication failed');
  }
}

/**
 * The scheme name is matched case-insensitively, as RFC 7235 requires.
 *
 * Not pedantry: getting this wrong would reject every webhook from a provider
 * that happened to send `basic`, and a rejected webhook is a household's reply
 * lost — silently, because the failure is on their side of the call.
 */
function decodeBasicCredentials(header: string | undefined): string | null {
  if (header === undefined) return null;

  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'basic' || rest.length !== 1) return null;

  try {
    return atob(rest[0] ?? '');
  } catch {
    return null;
  }
}

/**
 * Constant-time comparison, done by hashing both sides first.
 *
 * The secret is a fixed shared credential rather than per-user, so a plain
 * `===` would let a timing attack recover it byte by byte. Hashing first
 * means the comparison is always over two 64-character digests, whatever the
 * length of the credential itself, and the avalanche effect of SHA-256 means
 * a near-miss digest gives no information about which prefix was close.
 */
async function credentialsMatch(presented: string, expected: string): Promise<boolean> {
  const [presentedHash, expectedHash] = await Promise.all([
    sha256Hex(presented),
    sha256Hex(expected),
  ]);

  if (presentedHash.length !== expectedHash.length) return false;

  let diff = 0;
  for (let index = 0; index < presentedHash.length; index++) {
    diff |= presentedHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return diff === 0;
}
