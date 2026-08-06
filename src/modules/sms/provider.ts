import type { Logger } from '../../core/log.ts';

const SEND_URL = 'https://api.thesmsworks.co.uk/v1/message/send';

export type SmsSendResult =
  | { readonly ok: true; readonly providerMessageId: string }
  | { readonly ok: false; readonly reason: string };

export interface SmsProviderConfig {
  readonly apiKey: string;
  readonly sender: string;
}

/**
 * The only code that talks to TheSMSWorks.
 *
 * **Never log the message body or the destination number.** A failure reason
 * is safe to log — it is the provider's own short vocabulary, not personal
 * data — the same way a Turnstile error code is safe and the token is not.
 *
 * Returns a result rather than throwing: a failed send is not a bug here, it
 * is a `failure` row on the household's line. See `sms.service.ts`.
 */
export async function sendSms(
  config: SmsProviderConfig,
  destination: string,
  content: string,
  logger: Logger,
): Promise<SmsSendResult> {
  let response: Response;
  try {
    response = await fetch(SEND_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // No "Bearer " prefix — TheSMSWorks takes the JWT as the whole header.
        authorization: config.apiKey,
      },
      body: JSON.stringify({ sender: config.sender, destination, content }),
    });
  } catch {
    logger.warn('sms provider request failed');
    return { ok: false, reason: 'provider-unreachable' };
  }

  if (!response.ok) {
    logger.warn('sms provider refused the message', { code: String(response.status) });
    return { ok: false, reason: `provider-refused-${String(response.status)}` };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    logger.warn('sms provider response was not JSON');
    return { ok: false, reason: 'provider-malformed-response' };
  }

  const providerMessageId = extractMessageId(parsed);
  if (providerMessageId === null) {
    logger.warn('sms provider accepted the message but returned no id');
    return { ok: false, reason: 'provider-no-message-id' };
  }

  return { ok: true, providerMessageId };
}

/**
 * TheSMSWorks' send response is documented to carry the id under
 * `result.messageid`. **That exact shape is unverified against a live
 * account** — this is the one guess in this module that is not a product
 * requirement, so it is read defensively against a couple of plausible key
 * spellings rather than trusting one. Confirm the real response body against
 * TheSMSWorks before going live; see the module's report for how this was
 * flagged.
 */
function extractMessageId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;

  const direct = firstString(record, ['messageid', 'messageId', 'id', 'message_id']);
  if (direct !== null) return direct;

  const result = record.result;
  if (typeof result === 'object' && result !== null) {
    return firstString(result as Record<string, unknown>, ['messageid', 'messageId', 'id']);
  }

  return null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}
