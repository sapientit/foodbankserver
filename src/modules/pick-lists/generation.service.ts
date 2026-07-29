import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError, UnprocessableError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import type { NewParcel, NewParcelLine, PickList } from '../../db/schema/pick-lists.ts';
import type { Referral } from '../../db/schema/referrals.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import { modelParcelNameFor, type ParcelGrid } from '../rules/engine.ts';
import { parseContents, parseGrid } from '../rules/rules.service.ts';
import type { RulesRepository } from '../rules/rules.repository.ts';
import type { ReferralsRepository } from '../referrals/referrals.repository.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import type { PickListsRepository } from './pick-lists.repository.ts';

export interface GenerationDeps {
  readonly db: Database;
  readonly repository: PickListsRepository;
  readonly sessions: SessionsRepository;
  readonly referrals: ReferralsRepository;
  readonly rules: RulesRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface GenerationResult {
  readonly pickList: PickList;
  readonly parcelsCreated: number;
  readonly linesCreated: number;
  /** Referrals with no model parcel for their household size. */
  readonly skipped: { referralId: string; reason: string }[];
}

/**
 * Builds the pick list for a session.
 *
 * ## Query budget
 *
 * Five reads and one batched write, **regardless of how many referrals there
 * are**: existing pick list, session, referrals, model parcels, grid.
 * Everything else happens in memory. A per-referral lookup would be 25+
 * queries on a plan that allows 50 per invocation, and this is the endpoint a
 * team lead opens first thing on a session morning.
 *
 * ## Why the contents are copied
 *
 * The model parcel's lines are **copied** into `parcel_lines` rather than
 * resolved at print time. That copy is the whole immutability guarantee: edit
 * a model parcel tomorrow and a list generated today is untouched, so a
 * picker's sheet never changes under them. Nothing needs versioning to make
 * that true.
 */
export async function generatePickList(
  deps: GenerationDeps,
  sessionId: string,
  actor: Actor,
): Promise<GenerationResult> {
  const { db, repository, sessions, referrals, rules, clock, logger } = deps;

  const session = await sessions.findById(sessionId);
  if (session === undefined) {
    throw new NotFoundError('Session not found');
  }
  if (session.status === 'cancelled') {
    throw new ConflictError('That session has been cancelled');
  }

  const [activeReferrals, modelParcels, gridRow] = await Promise.all([
    referrals.list({ sessionId, status: 'active' }),
    rules.listModelParcels(),
    rules.findGrid(),
  ]);

  if (modelParcels.length === 0) {
    throw new UnprocessableError(
      'No model parcels have been set up, so a pick list cannot be generated',
    );
  }

  const grid = parseGrid(gridRow?.gridJson ?? null);
  const contentsByName = new Map(
    modelParcels.map((parcel) => [parcel.name, parseContents(parcel.contentsJson)]),
  );

  const now = clock.nowIso();
  const pickListId = crypto.randomUUID();

  const parcelRows: NewParcel[] = [];
  const lineRows: NewParcelLine[] = [];
  const skipped: { referralId: string; reason: string }[] = [];
  let pickNumber = 0;

  for (const referral of activeReferrals) {
    const resolved = resolveParcel(referral, grid, contentsByName);
    if ('reason' in resolved) {
      // One unresolvable referral must not stop the other twenty-four being
      // picked; it is reported instead so an admin can fix the grid.
      skipped.push({ referralId: referral.id, reason: resolved.reason });
      continue;
    }

    pickNumber += 1;
    const parcelId = crypto.randomUUID();

    parcelRows.push({
      id: parcelId,
      pickListId,
      referralId: referral.id,
      pickNumber,
      // Snapshots: amending the referral later must not change what was picked.
      adults: referral.adults,
      children: referral.children,
      createdAt: now,
      updatedAt: now,
    });

    for (const line of resolved.lines) {
      lineRows.push({
        id: crypto.randomUUID(),
        parcelId,
        stockItemId: line.stockItemId,
        quantity: line.quantity,
        source: 'model',
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // One native D1 batch: atomic, and json_each keeps it to three statements
  // however many parcels there are.
  const statements: D1PreparedStatement[] = [
    repository.buildInsertPickList({
      id: pickListId,
      sessionId,
      status: 'draft',
      generatedAt: now,
      generatedByUserId: actor.userId,
      firstPrintedAt: null,
      confirmedAt: null,
      confirmedByUserId: null,
      createdAt: now,
      updatedAt: now,
    }),
    ...(parcelRows.length === 0 ? [] : [repository.buildInsertParcels(parcelRows)]),
    ...(lineRows.length === 0 ? [] : [repository.buildInsertParcelLines(lineRows)]),
  ];

  try {
    await db.$client.batch(statements);
  } catch (error) {
    // Two people opening the session at the same moment. The unique index on
    // pick_lists.session_id decides; the loser reads what the winner made.
    if (isUniqueViolation(error, 'pick_lists.session_id')) {
      const existing = await repository.findBySession(sessionId);
      if (existing !== undefined) {
        logger.info('pick list already generated by a concurrent request', { sessionId });
        return { pickList: existing, parcelsCreated: 0, linesCreated: 0, skipped: [] };
      }
    }
    throw error;
  }

  const created = await repository.findBySession(sessionId);
  if (created === undefined) {
    throw new Error('Pick list was not created');
  }

  logger.info('generated pick list', {
    pickListId,
    sessionId,
    count: parcelRows.length,
    userId: actor.userId,
  });

  return {
    pickList: created,
    parcelsCreated: parcelRows.length,
    linesCreated: lineRows.length,
    skipped,
  };
}

type Resolved = { lines: { stockItemId: string; quantity: number }[] } | { reason: string };

function resolveParcel(
  referral: Referral,
  grid: ParcelGrid,
  contentsByName: ReadonlyMap<string, { stockItemId: string; quantity: number }[]>,
): Resolved {
  const name = modelParcelNameFor(grid, {
    adults: referral.adults,
    children: referral.children,
  });
  if (name === undefined) {
    return { reason: 'No model parcel is defined for that household size' };
  }

  const lines = contentsByName.get(name);
  if (lines === undefined) {
    return { reason: `The grid names a model parcel that does not exist: ${name}` };
  }

  return { lines };
}
