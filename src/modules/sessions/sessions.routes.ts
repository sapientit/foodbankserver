import { Hono, type Context } from 'hono';
import type { Actor } from '../../core/actor.ts';
import { UnauthorizedError } from '../../core/errors.ts';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseJsonBody, parseOptionalJsonBody, parseOrThrow } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import { runScheduledJobs } from '../jobs/run-scheduled.ts';
import { createSessionsRepository } from './sessions.repository.ts';
import { createSessionsService } from './sessions.service.ts';
import {
  toRecurringSessionResponse,
  toSessionResponse,
  type RecurringSessionResponse,
  type SessionResponse,
} from './sessions.mapper.ts';
import {
  adHocSessionSchema,
  cancelSessionSchema,
  recurringSessionInputSchema,
  recurringSessionPatchSchema,
  sessionListQuerySchema,
  sessionPatchSchema,
} from './sessions.schema.ts';

/**
 * Reads are open to anyone with an account — a team lead needs to see the
 * schedule to run a session. Writes are admin-only: re-timing or cancelling a
 * session affects every referral already attached to it.
 *
 * How far ahead a read reaches is not the same question as who may read: the
 * list is capped at six days for a team lead and uncapped for an admin, and
 * that cap lives in the service, from the `Actor`. Fetching one session by id
 * is not capped — see Q14.
 */
export function sessionRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /*
   * Auth is attached per route, deliberately not via `routes.use('*', ...)`.
   *
   * This sub-app is mounted at the shared `/api/v1` prefix, and a wildcard
   * `use` there applies to every path under it — including ones this module
   * does not serve. That turned unmatched API paths into 401s instead of 404s,
   * and would silently have required authentication on any public route
   * mounted after this one. Listing the middleware at each route also makes
   * the access level visible where it is granted.
   */
  const readers = [requireAuth, requireRole('admin', 'team_lead')] as const;
  const admins = [requireAuth, requireRole('admin')] as const;

  routes.get('/sessions', ...readers, async (c) => {
    const query = parseOrThrow(sessionListQuerySchema, {
      from: c.req.query('from'),
      to: c.req.query('to'),
      status: c.req.query('status'),
    });

    // The role decides how far ahead the answer reaches; the service applies
    // it, so no request can widen its own window.
    const sessions = await serviceFor(c).listSessions(actorOf(c), query);
    return c.json<{ sessions: SessionResponse[] }>({ sessions: sessions.map(toSessionResponse) });
  });

  routes.get('/sessions/:id', ...readers, async (c) => {
    const session = await serviceFor(c).getSessionWithBooked(c.req.param('id'));
    return c.json(toSessionResponse(session));
  });

  routes.post('/sessions', ...admins, async (c) => {
    const input = await parseJsonBody(c, adHocSessionSchema);
    const session = await serviceFor(c).createAdHoc(input);

    c.get('logger').info('created ad hoc session', { sessionId: session.session.id });
    return c.json(toSessionResponse(session), 201);
  });

  routes.patch('/sessions/:id', ...admins, async (c) => {
    const patch = await parseJsonBody(c, sessionPatchSchema);
    const session = await serviceFor(c).updateSession(c.req.param('id'), patch);

    c.get('logger').info('updated session', { sessionId: session.session.id });
    return c.json(toSessionResponse(session));
  });

  routes.post('/sessions/:id/cancel', ...admins, async (c) => {
    const { reason } = await parseOptionalJsonBody(c, cancelSessionSchema);
    const session = await serviceFor(c).cancelSession(c.req.param('id'), reason ?? null);

    c.get('logger').info('cancelled session', { sessionId: session.session.id });
    return c.json(toSessionResponse(session));
  });

  routes.get('/recurring-sessions', ...readers, async (c) => {
    const rows = await serviceFor(c).listRecurring();
    return c.json<{ recurringSessions: RecurringSessionResponse[] }>({
      recurringSessions: rows.map(toRecurringSessionResponse),
    });
  });

  routes.post('/recurring-sessions', ...admins, async (c) => {
    const input = await parseJsonBody(c, recurringSessionInputSchema);
    const created = await serviceFor(c).createRecurring(input);

    c.get('logger').info('created recurring session', { recurringSessionId: created.id });
    return c.json(toRecurringSessionResponse(created), 201);
  });

  routes.patch('/recurring-sessions/:id', ...admins, async (c) => {
    const patch = await parseJsonBody(c, recurringSessionPatchSchema);
    const updated = await serviceFor(c).updateRecurring(c.req.param('id'), patch);

    c.get('logger').info('updated recurring session', { recurringSessionId: updated.id });
    return c.json(toRecurringSessionResponse(updated));
  });

  /**
   * Runs the materialisation job on demand.
   *
   * Not a convenience: it is how the job gets tested without waiting for
   * 02:17, and how you recover from a cron that did not fire. It calls exactly
   * the same function the scheduled handler does.
   */
  routes.post('/jobs/session-materialisation/run', ...admins, async (c) => {
    const result = await runScheduledJobs({
      db: c.get('db'),
      clock: c.get('clock'),
      logger: c.get('logger'),
      piiRetentionDays: c.get('config').piiRetentionDays,
    });
    return c.json(result);
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

function serviceFor(c: Context<AppEnv>) {
  return createSessionsService({
    repository: createSessionsRepository(c.get('db')),
    clock: c.get('clock'),
  });
}
