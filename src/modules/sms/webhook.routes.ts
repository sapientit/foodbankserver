import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BadRequestError } from '../../core/errors.ts';
import { rateLimit } from '../../http/middleware/rate-limit.ts';
import { parseJsonBody } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import { createSmsService } from './sms.service.ts';
import { smsServiceDeps } from './sms.routes.ts';
import { parseWebhookPayload } from './sms.schema.ts';
import { requireWebhookAuth } from './webhook-auth.ts';

/**
 * The one public, unauthenticated route in this module.
 *
 * Public and writing into the most sensitive table in the system, so it gets
 * the same two-part treatment as referral submission: rate limiting, and a
 * credential check — here HTTP Basic against a shared secret, since that is
 * what TheSMSWorks presents rather than a bot-check token. See
 * `webhook-auth.ts`, and `INITIAL_SPEC1.txt`, "SMS reminders and replies".
 */
export function webhookRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/webhooks/sms', rateLimit('SMS_WEBHOOK_LIMITER'), async (c) => {
    await requireWebhookAuth({
      secret: c.get('config').smsWebhookSecret,
      authorizationHeader: c.req.header('authorization'),
    });

    const raw = await parseJsonBody(c, z.unknown());
    const payload = parseWebhookPayload(raw);
    if (payload === null) {
      throw new BadRequestError('This does not look like an SMS delivery');
    }

    await serviceFor(c).receiveInbound(payload);

    // TheSMSWorks retries anything that does not get a 200, and there is
    // nothing useful to report back to it either way.
    return c.json({ ok: true });
  });

  return routes;
}

function serviceFor(c: Context<AppEnv>) {
  return createSmsService(smsServiceDeps(c));
}
