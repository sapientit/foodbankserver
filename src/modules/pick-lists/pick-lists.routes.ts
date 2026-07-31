import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Actor } from '../../core/actor.ts';
import { UnauthorizedError } from '../../core/errors.ts';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseJsonBody } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import { createReferralsRepository } from '../referrals/referrals.repository.ts';
import { createRulesRepository } from '../rules/rules.repository.ts';
import { createSessionsRepository } from '../sessions/sessions.repository.ts';
import { createPickListsRepository } from './pick-lists.repository.ts';
import { createPickListsService } from './pick-lists.service.ts';
import { createAttendanceService } from './attendance.service.ts';
import {
  toParcelResponse,
  toPickListResponse,
  toPrintParcelResponse,
  type ParcelResponse,
  type PrintParcelResponse,
} from './pick-lists.mapper.ts';

const lineSchema = z.object({
  stockItemId: z.uuid(),
  /** Zero removes the line, which is how a picker says "we had none". */
  quantity: z.number().int().min(0).max(1000),
});

const notesSchema = z.object({
  notes: z.string().trim().max(500).nullable(),
});

const attendanceSchema = z.object({
  attendance: z.enum(['attended', 'no_show']),
});

/**
 * Team leads run sessions, so they generate, edit, print and confirm pick
 * lists. Nothing here is admin-only — an admin is not going to be in the hall
 * on a Tuesday morning.
 */
export function pickListRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const staff = [requireAuth, requireRole('admin', 'team_lead')] as const;

  /**
   * The session's pick list, generating it on first view.
   *
   * A POST rather than a GET because it creates. The frontend calls this when
   * the picking screen is opened; calling it again is harmless.
   */
  routes.post('/sessions/:sessionId/pick-list', ...staff, async (c) => {
    const result = await serviceFor(c).getOrGenerate(c.req.param('sessionId'), actorOf(c));

    return c.json({
      ...toPickListResponse(result.pickList),
      parcelsCreated: result.parcelsCreated,
      linesCreated: result.linesCreated,
      skipped: result.skipped,
    });
  });

  routes.get('/sessions/:sessionId/pick-list', ...staff, async (c) => {
    const service = serviceFor(c);
    const pickList = await service.getOrGenerate(c.req.param('sessionId'), actorOf(c));
    const parcels = await service.listParcelsWithLines(pickList.pickList.id);

    return c.json<{ pickList: ReturnType<typeof toPickListResponse>; parcels: ParcelResponse[] }>({
      pickList: toPickListResponse(pickList.pickList),
      parcels: parcels.map(toParcelResponse),
    });
  });

  routes.get('/pick-lists/:id', ...staff, async (c) => {
    const service = serviceFor(c);
    const pickList = await service.getPickList(c.req.param('id'));
    const parcels = await service.listParcelsWithLines(pickList.id);

    return c.json({
      pickList: toPickListResponse(pickList),
      parcels: parcels.map(toParcelResponse),
    });
  });

  /** What has changed since generation, so nothing is applied behind a picker. */
  routes.get('/pick-lists/:id/divergence', ...staff, async (c) => {
    const service = serviceFor(c);
    const pickList = await service.getPickList(c.req.param('id'));

    return c.json(await service.divergence(pickList));
  });

  /**
   * The printable payload: one sheet per parcel, lines ordered by shelf.
   *
   * JSON, not HTML — the frontend owns layout. See CLAUDE.md.
   */
  routes.get('/pick-lists/:id/print', ...staff, async (c) => {
    const service = serviceFor(c);
    const pickList = await service.getPickList(c.req.param('id'));
    const parcels = await service.listParcelsWithLines(pickList.id);

    // One query for every referral involved rather than one per parcel.
    const referrals = await createReferralsRepository(c.get('db')).list({
      sessionId: pickList.sessionId,
    });
    const byId = new Map(referrals.map((referral) => [referral.id, referral]));

    return c.json<{
      pickList: ReturnType<typeof toPickListResponse>;
      parcels: PrintParcelResponse[];
    }>({
      pickList: toPickListResponse(pickList),
      parcels: parcels.map((entry) =>
        toPrintParcelResponse(entry, byId.get(entry.parcel.referralId)),
      ),
    });
  });

  routes.put('/parcels/:id/lines', ...staff, async (c) => {
    const { stockItemId, quantity } = await parseJsonBody(c, lineSchema);
    await serviceFor(c).setLine(c.req.param('id'), stockItemId, quantity);

    return c.body(null, 204);
  });

  routes.delete('/parcels/:id/lines/:stockItemId', ...staff, async (c) => {
    await serviceFor(c).removeLine(c.req.param('id'), c.req.param('stockItemId'));
    return c.body(null, 204);
  });

  routes.patch('/parcels/:id', ...staff, async (c) => {
    const { notes } = await parseJsonBody(c, notesSchema);
    const updated = await serviceFor(c).setParcelNotes(c.req.param('id'), notes);

    return c.json({ id: updated.id, notes: updated.notes });
  });

  routes.post('/pick-lists/:id/print', ...staff, async (c) => {
    const updated = await serviceFor(c).markPrinted(c.req.param('id'));
    return c.json(toPickListResponse(updated));
  });

  /**
   * Whether a household turned up.
   *
   * Attended issues the parcel and decrements stock; a no-show moves nothing,
   * because nothing was given away. Submitting the same outcome twice is safe;
   * submitting the other one is refused, because an outcome is final. See
   * `attendance.service.ts`.
   */
  routes.post('/parcels/:id/attendance', ...staff, async (c) => {
    const { attendance } = await parseJsonBody(c, attendanceSchema);
    const result = await attendanceFor(c).record(c.req.param('id'), attendance, actorOf(c));

    return c.json({
      id: result.parcel.id,
      attendance: result.parcel.attendance,
      stockMoved: result.stockMoved,
      alreadyRecorded: result.alreadyRecorded,
    });
  });

  /** The team lead's end-of-session step. Refuses while anyone is unrecorded. */
  routes.post('/sessions/:sessionId/confirm', ...staff, async (c) => {
    const session = await attendanceFor(c).confirmSession(c.req.param('sessionId'), actorOf(c));

    return c.json({
      id: session.id,
      status: session.status,
      confirmedAt: session.confirmedAt,
    });
  });

  /** Locks the list. Deliberately does **not** move stock — that is attendance. */
  routes.post('/pick-lists/:id/confirm', ...staff, async (c) => {
    const updated = await serviceFor(c).confirm(c.req.param('id'), actorOf(c));
    return c.json(toPickListResponse(updated));
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

function attendanceFor(c: Context<AppEnv>) {
  const db = c.get('db');
  return createAttendanceService({
    db,
    repository: createPickListsRepository(db),
    sessions: createSessionsRepository(db),
    clock: c.get('clock'),
    logger: c.get('logger'),
  });
}

function serviceFor(c: Context<AppEnv>) {
  const db = c.get('db');
  return createPickListsService({
    db,
    repository: createPickListsRepository(db),
    sessions: createSessionsRepository(db),
    referrals: createReferralsRepository(db),
    rules: createRulesRepository(db),
    clock: c.get('clock'),
    logger: c.get('logger'),
  });
}
