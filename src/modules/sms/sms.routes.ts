import { Hono, type Context } from 'hono';
import type { Actor } from '../../core/actor.ts';
import { UnauthorizedError } from '../../core/errors.ts';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseJsonBody } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import { createSessionsRepository } from '../sessions/sessions.repository.ts';
import { createSmsRepository } from './sms.repository.ts';
import { createSmsService, type SmsServiceDeps } from './sms.service.ts';
import { toSmsMessageResponse, type SmsMessageResponse } from './sms.mapper.ts';
import { staffReplySchema } from './sms.schema.ts';

/**
 * The authenticated half of the module. `webhook.routes.ts` is the other,
 * public, half — see there for why they are separate files.
 *
 * Reads and replies are open to a team lead as well as an admin: **a
 * deliberate second exception**, of the same kind as the listener sheet, to
 * "a team lead does not see the reason for referral" — see
 * `INITIAL_SPEC1.txt`, "SMS reminders and replies". Loose replies stay
 * admin-only, because they carry no session for a team lead to be running.
 */
export function smsRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const staff = [requireAuth, requireRole('admin', 'team_lead')] as const;
  const admins = [requireAuth, requireRole('admin')] as const;

  routes.post('/sessions/:sessionId/sms-reminders', ...staff, async (c) => {
    const result = await serviceFor(c).sendReminders(c.req.param('sessionId'), actorOf(c));
    return c.json(result);
  });

  routes.get('/sessions/:sessionId/sms-summary', ...staff, async (c) => {
    const result = await serviceFor(c).summaryForSession(c.req.param('sessionId'));
    return c.json(result);
  });

  routes.get('/referrals/:id/sms-messages', ...staff, async (c) => {
    const referralId = c.req.param('id');
    const messages = await serviceFor(c).getThread(referralId);

    return c.json<{ referralId: string; messages: SmsMessageResponse[] }>({
      referralId,
      messages: messages.map(toSmsMessageResponse),
    });
  });

  routes.post('/referrals/:id/sms-messages/read', ...staff, async (c) => {
    await serviceFor(c).markThreadRead(c.req.param('id'));
    return c.body(null, 204);
  });

  routes.post('/referrals/:id/sms-messages', ...staff, async (c) => {
    const { body } = await parseJsonBody(c, staffReplySchema);
    const message = await serviceFor(c).sendStaffReply(c.req.param('id'), body, actorOf(c));

    return c.json(toSmsMessageResponse(message), 201);
  });

  routes.get('/sms-messages/unmatched', ...admins, async (c) => {
    const messages = await serviceFor(c).listUnmatched();
    return c.json<{ messages: SmsMessageResponse[] }>({
      messages: messages.map(toSmsMessageResponse),
    });
  });

  routes.post('/sms-messages/:id/read', ...admins, async (c) => {
    const message = await serviceFor(c).markUnmatchedRead(c.req.param('id'));
    return c.json(toSmsMessageResponse(message));
  });

  return routes;
}

function actorOf(c: Context<AppEnv>): Actor {
  const actor = c.get('actor');
  if (actor === undefined) {
    throw new UnauthorizedError('Authentication required');
  }
  return actor;
}

/** Shared with `webhook.routes.ts`, which has no actor and no session repository need beyond this. */
export function smsServiceDeps(c: Context<AppEnv>): SmsServiceDeps {
  const db = c.get('db');
  const config = c.get('config');

  return {
    db,
    repository: createSmsRepository(db),
    sessions: createSessionsRepository(db),
    clock: c.get('clock'),
    logger: c.get('logger'),
    provider:
      config.smsApiKey === undefined || config.smsSender === undefined
        ? undefined
        : { apiKey: config.smsApiKey, sender: config.smsSender },
  };
}

function serviceFor(c: Context<AppEnv>) {
  return createSmsService(smsServiceDeps(c));
}
