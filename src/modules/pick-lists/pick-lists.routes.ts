import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Actor } from '../../core/actor.ts';
import { UnauthorizedError } from '../../core/errors.ts';
import { isPlainDate } from '../../core/time/plain-date.ts';
import { requireAuth, requireRole } from '../../http/middleware/require-auth.ts';
import { parseJsonBody, parseOptionalJsonBody, parseOrThrow } from '../../http/validate.ts';
import type { AppEnv } from '../../http/types.ts';
import { createReferralsRepository } from '../referrals/referrals.repository.ts';
import { createRulesRepository } from '../rules/rules.repository.ts';
import { createSessionsRepository } from '../sessions/sessions.repository.ts';
import { createStockRepository } from '../stock/stock.repository.ts';
import { createVoucherConfigRepository } from '../voucher-config/voucher-config.repository.ts';
import { stockOrderSchema } from '../stock/stock.schema.ts';
import { createPickListsRepository } from './pick-lists.repository.ts';
import { generatePickListSchema, parcelNotesSchema } from './pick-lists.schema.ts';
import { createPickListsService } from './pick-lists.service.ts';
import { createAttendanceService } from './attendance.service.ts';
import {
  toParcelResponse,
  toPickListResponse,
  toPrintParcelResponse,
  toStockRequirementResponse,
  toStockRequirementSummaryResponse,
  type ParcelResponse,
  type PrintParcelResponse,
  type StockRequirementResponse,
  type StockRequirementSummaryResponse,
} from './pick-lists.mapper.ts';

const lineSchema = z.object({
  stockItemId: z.uuid(),
  /** Zero removes the line, which is how a picker says "we had none". */
  quantity: z.number().int().min(0).max(1000),
});

/** `null` clears the note; the limit is the one generation writes under. */
const notesSchema = z.object({
  notes: parcelNotesSchema.nullable(),
});

const attendanceSchema = z.object({
  attendance: z.enum(['attended', 'no_show']),
});

/** The cut-off date for the cross-session stock requirement report. */
const stockRequirementSummaryQuerySchema = z.object({
  upTo: z.string().refine(isPlainDate, 'must be a real YYYY-MM-DD date'),
});

/**
 * Team leads run sessions, so they generate, edit and print pick lists, and
 * confirm the session itself once it is done. Nothing here is admin-only — an
 * admin is not going to be in the hall on a Tuesday morning.
 */
export function pickListRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const staff = [requireAuth, requireRole('admin', 'team_lead')] as const;
  /** The cross-session stock requirement report is planning, not the picking floor — admin only. */
  const admins = [requireAuth, requireRole('admin')] as const;

  /**
   * The session's pick list, generating it on first view.
   *
   * A POST rather than a GET because it creates. The frontend calls this when
   * the picking screen is opened; calling it again is harmless.
   *
   * The body is optional and carries what the client's own rules and form
   * definition produced — the preference lines it resolved and the pick-list
   * information it composed. It POSTs bare when there is neither, which is why
   * this parses optionally rather than requiring a body.
   */
  routes.post('/sessions/:sessionId/pick-list', ...staff, async (c) => {
    const { preferenceLines, pickListInformation } = await parseOptionalJsonBody(
      c,
      generatePickListSchema,
    );
    const result = await serviceFor(c).getOrGenerate(c.req.param('sessionId'), actorOf(c), {
      preferenceLines,
      pickListInformation,
    });

    return c.json({
      ...toPickListResponse(result.pickList),
      parcelsCreated: result.parcelsCreated,
      linesCreated: result.linesCreated,
      preferenceLinesApplied: result.preferenceLinesApplied,
      preferenceLinesDropped: result.preferenceLinesDropped,
      preferenceReferralsIgnored: result.preferenceReferralsIgnored,
    });
  });

  routes.get('/sessions/:sessionId/pick-list', ...staff, async (c) => {
    const service = serviceFor(c);
    const pickList = await service.getPickListForSession(c.req.param('sessionId'));
    const parcels = await service.listParcelsWithLines(pickList.id);
    const byId = await referralsBySession(c, pickList.sessionId);

    return c.json<{ pickList: ReturnType<typeof toPickListResponse>; parcels: ParcelResponse[] }>({
      pickList: toPickListResponse(pickList),
      parcels: parcels.map((entry) => toParcelResponse(entry, byId.get(entry.parcel.referralId))),
    });
  });

  /**
   * The running total of what every session still to come is going to need,
   * up to a chosen cut-off date — `INITIAL_SPEC1.txt`, `#Stock requirement
   * report`. An administrator's planning report, not the per-session
   * comparison below, and deliberately different from it in every way that
   * matters: admin-only rather than staff, spans every not-yet-confirmed
   * session on or before `upTo` rather than one, a `-1` line is dropped from
   * the total rather than refusing the report, there is no review gate
   * because most of the sessions it covers are not yet picked, and it has no
   * stock level to compare against — the total, not a shortfall.
   *
   * **Registered ahead of `/pick-lists/:id`.** Hono matches routes in
   * registration order, so a static segment registered after a `:id` route
   * is shadowed by it — `stock-requirement-summary` would otherwise be read
   * as an id and 404. `stock.routes.ts`'s `/stock/items/low-stock-summary`
   * is the existing example of the same trap.
   */
  routes.get('/pick-lists/stock-requirement-summary', ...admins, async (c) => {
    const { upTo } = parseOrThrow(stockRequirementSummaryQuerySchema, {
      upTo: c.req.query('upTo'),
    });
    const requested = c.req.query('order');
    const order = requested === undefined ? 'shelf' : parseOrThrow(stockOrderSchema, requested);
    const lines = await serviceFor(c).stockRequirementSummary(upTo, order);

    return c.json<{ items: StockRequirementSummaryResponse[] }>({
      items: lines.map(toStockRequirementSummaryResponse),
    });
  });

  routes.get('/pick-lists/:id', ...staff, async (c) => {
    const service = serviceFor(c);
    const pickList = await service.getPickList(c.req.param('id'));
    const parcels = await service.listParcelsWithLines(pickList.id);
    const byId = await referralsBySession(c, pickList.sessionId);

    return c.json({
      pickList: toPickListResponse(pickList),
      parcels: parcels.map((entry) => toParcelResponse(entry, byId.get(entry.parcel.referralId))),
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
   * JSON, not HTML — the frontend owns layout. See CLAUDE.md. A `409` while any
   * parcel is still unreviewed.
   */
  routes.get('/pick-lists/:id/print', ...staff, async (c) => {
    const service = serviceFor(c);
    const pickList = await service.getPickList(c.req.param('id'));
    const parcels = await service.listParcelsForPrint(pickList.id);
    const { session, voucherRange } = await service.printContext(pickList);

    const byId = await referralsBySession(c, pickList.sessionId);

    return c.json<{
      pickList: ReturnType<typeof toPickListResponse>;
      parcels: PrintParcelResponse[];
    }>({
      pickList: toPickListResponse(pickList),
      parcels: parcels.map((entry) =>
        toPrintParcelResponse(entry, byId.get(entry.parcel.referralId), {
          sessionDate: session.sessionDate,
          voucherRange,
        }),
      ),
    });
  });

  /**
   * What the session needs off the shelves, against what is on them.
   *
   * Only the items its parcels call for. Shelf order by default: the person
   * asking is usually about to go and look. A `409` while any parcel is still
   * unreviewed, the same gate as printing — see the service.
   */
  routes.get('/sessions/:sessionId/stock-requirement', ...staff, async (c) => {
    const requested = c.req.query('order');
    const order = requested === undefined ? 'shelf' : parseOrThrow(stockOrderSchema, requested);
    const { pickList, lines } = await serviceFor(c).stockRequirement(
      c.req.param('sessionId'),
      order,
    );

    return c.json<{ pickListId: string; items: StockRequirementResponse[] }>({
      pickListId: pickList.id,
      items: lines.map(toStockRequirementResponse),
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

  routes.post('/parcels/:id/review', ...staff, async (c) => {
    const parcel = await serviceFor(c).markParcelReviewed(c.req.param('id'));
    return c.json({ id: parcel.id, reviewedAt: parcel.reviewedAt });
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

  return routes;
}

/**
 * Every referral on a session, by id, in **one** query rather than one per
 * parcel — 25 parcels on a plan that allows 50 queries leaves no room for it.
 *
 * No status filter: a parcel exists because the referral was active when the
 * list was generated, and a referral cancelled since must still resolve, or its
 * sheet would silently lose the name it is picked against.
 */
async function referralsBySession(c: Context<AppEnv>, sessionId: string) {
  const rows = await createReferralsRepository(c.get('db')).list({ sessionId });
  return new Map(rows.map((referral) => [referral.id, referral]));
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
    stock: createStockRepository(db),
    voucherConfig: createVoucherConfigRepository(db),
    clock: c.get('clock'),
    logger: c.get('logger'),
  });
}
