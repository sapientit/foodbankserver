import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError, UnprocessableError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import type { NewParcel, NewParcelLine, PickList } from '../../db/schema/pick-lists.ts';
import { REFERRAL_STATUSES_HOLDING_A_PLACE, type Referral } from '../../db/schema/referrals.ts';
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
  existingPickList?: PickList,
  attempts = 0,
): Promise<GenerationResult> {
  const { db, repository, sessions, referrals, rules, clock, logger } = deps;

  const session = await sessions.findById(sessionId);
  if (session === undefined) {
    throw new NotFoundError('Session not found');
  }
  if (session.status === 'cancelled') {
    throw new ConflictError('That session has been cancelled');
  }
  if (session.status === 'confirmed') {
    if (existingPickList !== undefined) {
      return { pickList: existingPickList, parcelsCreated: 0, linesCreated: 0 };
    }
    throw new ConflictError('This session has been confirmed and can no longer be changed');
  }

  // Pick-list eligibility deliberately matches SMS reminders: a household
  // holding a place may turn up, so it needs a parcel and a named row for the
  // team running the session. Cancelled and rejected referrals hold no place.
  const [pickableReferrals, modelParcels, gridRow] = await Promise.all([
    referrals.list({ sessionId, statuses: REFERRAL_STATUSES_HOLDING_A_PLACE }),
    rules.listModelParcels(),
    rules.findGrid(),
  ]);

  const existingParcels =
    existingPickList === undefined ? [] : await repository.listParcels(existingPickList.id);
  const coveredReferrals = new Set(existingParcels.map((parcel) => parcel.referralId));

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
  const pickListId = existingPickList?.id ?? crypto.randomUUID();

  const parcelRows: NewParcel[] = [];
  const lineRows: NewParcelLine[] = [];
  const resolvedParcels: { referral: Referral; lines: ResolvedLines }[] = [];
  const unresolvedHouseholdSizes = new Set<string>();
  let pickNumber = existingParcels.reduce(
    (highest, parcel) => Math.max(highest, parcel.pickNumber),
    0,
  );

  for (const referral of pickableReferrals) {
    if (coveredReferrals.has(referral.id)) continue;

    const resolved = resolveParcel(referral, grid, contentsByName);
    if ('reason' in resolved) {
      unresolvedHouseholdSizes.add(householdSize(referral));
      continue;
    }

    resolvedParcels.push({ referral, lines: resolved.lines });
  }

  // A session must never leave staff with a partly-generated list. Resolve
  // every missing household first, then make the single atomic write.
  if (unresolvedHouseholdSizes.size > 0) {
    throw new UnprocessableError(
      'The household grid is incomplete. Complete it before generating pick lists.',
      { details: { missingHouseholdSizes: [...unresolvedHouseholdSizes].sort() } },
    );
  }

  for (const { referral, lines } of resolvedParcels) {
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

    for (const line of lines) {
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
  if (existingPickList !== undefined && parcelRows.length === 0) {
    return { pickList: existingPickList, parcelsCreated: 0, linesCreated: 0 };
  }

  const statements: D1PreparedStatement[] = [
    ...(existingPickList === undefined
      ? [
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
        ]
      : []),
    ...(parcelRows.length === 0 ? [] : [repository.buildInsertParcels(parcelRows)]),
    ...(lineRows.length === 0 ? [] : [repository.buildInsertParcelLines(lineRows)]),
  ];

  try {
    await db.$client.batch(statements);
  } catch (error) {
    // The unique indexes decide concurrent reconciliation. A loser re-reads
    // the list and retries against the now-current parcels, never overwriting
    // anything a picker has already adjusted.
    if (isUniqueViolation(error, 'pick_lists.session_id')) {
      const existing = await repository.findBySession(sessionId);
      if (existing !== undefined) {
        logger.info('pick list already generated by a concurrent request', { sessionId });
        return generatePickList(deps, sessionId, actor, existing, attempts + 1);
      }
    }

    if (
      existingPickList !== undefined &&
      attempts < 3 &&
      (isUniqueViolation(error, 'parcels.pick_list_id', 'parcels.referral_id') ||
        isUniqueViolation(error, 'parcels.pick_list_id', 'parcels.pick_number'))
    ) {
      const current = await repository.findBySession(sessionId);
      if (current !== undefined && current.status !== 'confirmed') {
        return generatePickList(deps, sessionId, actor, current, attempts + 1);
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
  };
}

type ResolvedLines = { stockItemId: string; quantity: number }[];
type Resolved = { lines: ResolvedLines } | { reason: string };

function householdSize(referral: Referral): string {
  return `${String(referral.adults)} adult${referral.adults === 1 ? '' : 's'}, ${String(
    referral.children,
  )} child${referral.children === 1 ? '' : 'ren'}`;
}

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
