import { z } from 'zod';

/**
 * A staff reply is free text typed by a person, bound by the same rule as the
 * reminder: no name, and nothing that says who the number belongs to. That
 * rule cannot be enforced on something a human types — see
 * `INITIAL_SPEC1.txt`, "SMS reminders and replies" — so this only bounds
 * length. 918 characters is six GSM-7 segments, which is generous for a reply
 * and still nowhere near the size that would make this a storage vector.
 */
export const staffReplySchema = z.object({
  body: z.string().trim().min(1).max(918),
});
export type StaffReplyInput = z.infer<typeof staffReplySchema>;

const webhookRawSchema = z.record(z.string(), z.unknown());

export interface WebhookInboundMessage {
  readonly phone: string;
  readonly body: string;
  readonly providerMessageId: string | null;
}

/**
 * Parses TheSMSWorks' inbound webhook body.
 *
 * **The exact field names are not confirmed against a live account** — this
 * reads defensively across a few plausible spellings for the sender's number,
 * the text and the provider's message id, the same way `provider.ts` reads
 * the send response defensively. Flagged in the module's report; verify
 * against a real payload before this goes live and narrow this once it is.
 *
 * Returns `null` when the payload does not carry a recognisable number and
 * body — the route logs that it happened (a count, not the payload) and
 * refuses with a 400 rather than writing a message with no number to reply to.
 */
export function parseWebhookPayload(raw: unknown): WebhookInboundMessage | null {
  const result = webhookRawSchema.safeParse(raw);
  if (!result.success) return null;
  const record = result.data;

  const phone = firstString(record, ['source', 'from', 'sender', 'originator', 'mobile']);
  const body = firstString(record, ['content', 'body', 'message', 'text']);
  if (phone === null || body === null) return null;

  return {
    phone,
    body,
    providerMessageId: firstString(record, ['messageid', 'messageId', 'id', 'message_id']),
  };
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}
