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
import type { StockRepository } from '../stock/stock.repository.ts';
import type { PickListsRepository } from './pick-lists.repository.ts';
import { mergePreferenceLines, type ParcelContentLine } from './preference-lines.ts';
import type { PickListInformationSet, PreferenceLineSet } from './pick-lists.schema.ts';

export interface GenerationDeps {
  readonly db: Database;
  readonly repository: PickListsRepository;
  readonly sessions: SessionsRepository;
  readonly referrals: ReferralsRepository;
  readonly rules: RulesRepository;
  readonly stock: StockRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface GenerationResult {
  readonly pickList: PickList;
  readonly parcelsCreated: number;
  readonly linesCreated: number;
  /** Preference lines merged into parcels this call actually created. */
  readonly preferenceLinesApplied: number;
  /** Preference lines whose stock item has since been deactivated. */
  readonly preferenceLinesDropped: number;
  /** Supplied referrals that already had a parcel, or are not owed one. */
  readonly preferenceReferralsIgnored: number;
}

export interface GenerateOptions {
  /**
   * Lines the client's preference rules resolved, by referral.
   *
   * Applied only to parcels this call creates. An existing parcel is never
   * touched, however many times the same lines are sent.
   */
  readonly preferenceLines?: PreferenceLineSet;
  /**
   * Pick-list information the client composed from the referral's answers.
   *
   * Written onto parcels this call creates and nowhere else. An existing
   * parcel's note is a snapshot the team leader may already have corrected, and
   * overwriting it is precisely the failure this rule exists to prevent.
   */
  readonly pickListInformation?: PickListInformationSet;
  readonly existingPickList?: PickList;
  readonly attempts?: number;
}

const NOTHING_GENERATED = {
  parcelsCreated: 0,
  linesCreated: 0,
  preferenceLinesApplied: 0,
  preferenceLinesDropped: 0,
  preferenceReferralsIgnored: 0,
} as const;

/**
 * Builds the pick list for a session.
 *
 * ## Query budget
 *
 * **Six to eight reads and one batched write, regardless of how many referrals
 * there are.** Always: the existing pick list (in `getOrGenerate`), the
 * session, the referrals, the model parcels, the grid, and a re-read of the
 * pick list after the batch. Plus the existing parcels when reconciling, and
 * the stock catalogue when the request carries preference lines. Each retry
 * after a concurrent write adds one more.
 *
 * Everything else happens in memory, and that is the point: a per-referral
 * lookup would be 25+ queries on a plan that allows 50 per invocation, and
 * this is the endpoint a team lead opens first thing on a session morning. The
 * catalogue is fetched whole for the same reason — one query however many
 * items are named, where `inArray` would bind one parameter per id against a
 * limit of 100.
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
  options: GenerateOptions = {},
): Promise<GenerationResult> {
  const { db, repository, sessions, referrals, rules, stock, clock, logger } = deps;
  const {
    preferenceLines = [],
    pickListInformation = [],
    existingPickList,
    attempts = 0,
  } = options;

  const session = await sessions.findById(sessionId);
  if (session === undefined) {
    throw new NotFoundError('Session not found');
  }
  if (session.status === 'cancelled') {
    throw new ConflictError('That session has been cancelled');
  }
  if (session.status === 'confirmed') {
    if (existingPickList !== undefined) {
      return { pickList: existingPickList, ...NOTHING_GENERATED };
    }
    throw new ConflictError('This session has been confirmed and can no longer be changed');
  }

  // Every referral on the session, not only the pickable ones, and still one
  // query. The extra rows are what lets a preference line be checked against
  // the session it claims to belong to: filtering in SQL would leave a line
  // naming a cancelled household indistinguishable from one naming a household
  // on a different session altogether, and those want different answers.
  const [sessionReferrals, modelParcels, gridRow, stockItems] = await Promise.all([
    referrals.list({ sessionId }),
    rules.listModelParcels(),
    rules.findGrid(),
    preferenceLines.length === 0 ? Promise.resolve([]) : stock.listItems(false, 'shelf'),
  ]);

  // Pick-list eligibility deliberately matches SMS reminders: a household
  // holding a place may turn up, so it needs a parcel and a named row for the
  // team running the session. Cancelled and rejected referrals hold no place.
  // Filtered in memory, which preserves `list`'s `referredAt` order and so the
  // order pick numbers are handed out in.
  const holdsAPlace = new Set<string>(REFERRAL_STATUSES_HOLDING_A_PLACE);
  const pickableReferrals = sessionReferrals.filter((referral) => holdsAPlace.has(referral.status));

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

  // A preference line names the referral it was resolved for, and that referral
  // has to be one on this session. The client builds these from its own view of
  // a session's households, so an id from somewhere else is a bug in that view
  // — a stale tab, the wrong session, a mistyped request — and the honest
  // answer is to refuse the whole request rather than to write parcels for
  // everyone else and report a number the client has no way to interpret.
  //
  // A household that *is* on the session but is not owed a parcel — cancelled,
  // rejected, or already picked — is a different matter and is still counted as
  // ignored below. That one is an ordinary race between the client evaluating
  // its rules and somebody cancelling a referral, and failing a session's
  // generation over it would be the wrong trade on a Tuesday morning.
  const sessionReferralIds = new Set(sessionReferrals.map((referral) => referral.id));
  const offSessionReferralIds = [
    ...new Set(
      preferenceLines.map((entry) => entry.referralId).filter((id) => !sessionReferralIds.has(id)),
    ),
  ].sort();
  if (offSessionReferralIds.length > 0) {
    throw new UnprocessableError('Preference lines name referrals that are not on this session', {
      details: { offSessionReferralIds },
    });
  }

  // Pick-list information is checked the same way and for the same reason. A
  // note is written for one household and says what may not be fed to them, so
  // an id from another session is the one mistake that must never be half
  // applied — better to refuse the request than to attach somebody's allergy to
  // the wrong bag or to silently drop it.
  const offSessionAnnotatedIds = [
    ...new Set(
      pickListInformation
        .map((entry) => entry.referralId)
        .filter((id) => !sessionReferralIds.has(id)),
    ),
  ].sort();
  if (offSessionAnnotatedIds.length > 0) {
    throw new UnprocessableError(
      'Pick-list information names referrals that are not on this session',
      { details: { offSessionReferralIds: offSessionAnnotatedIds } },
    );
  }

  // Keyed by referral and read only in the creation loop below, so a household
  // that is on the session but not owed a parcel — cancelled, rejected, already
  // picked — simply never has its note looked up. That is the same ordinary
  // race the preference lines tolerate.
  const notesByReferral = new Map(
    pickListInformation.map((entry) => [entry.referralId, entry.notes]),
  );

  // Every supplied id is checked against the catalogue before a single
  // statement is composed. An id the catalogue does not know would otherwise
  // reach `parcel_lines.stock_item_id` inside the atomic batch, and a
  // foreign-key failure there is not a shape the retry below recognises: it
  // would surface as an opaque 500, having written nothing and explained
  // nothing.
  const itemsById = new Map(stockItems.map((item) => [item.id, item]));
  const unknownStockItemIds = [
    ...new Set(
      preferenceLines.flatMap((entry) =>
        entry.lines.map((line) => line.stockItemId).filter((id) => !itemsById.has(id)),
      ),
    ),
  ].sort();
  if (unknownStockItemIds.length > 0) {
    throw new UnprocessableError('Preference lines name stock items that do not exist', {
      details: { unknownStockItemIds },
    });
  }

  // A deactivated item is dropped rather than refused. It is a race — the item
  // was on the list the client evaluated against and has been retired since —
  // and failing a session's generation over a nice-to-have would be the wrong
  // trade on a Tuesday morning. Reported in the response rather than silently
  // swallowed. Items are deactivated and never deleted, which is what makes
  // unknown and inactive different answers to different questions.
  const preferencesByReferral = new Map<string, ParcelContentLine[]>();
  let preferenceLinesDropped = 0;
  for (const entry of preferenceLines) {
    const usable = entry.lines.filter((line) => itemsById.get(line.stockItemId)?.isActive === 1);
    preferenceLinesDropped += entry.lines.length - usable.length;
    preferencesByReferral.set(entry.referralId, usable);
  }

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

  // Preference lines reach a parcel only as it is created. A referral that
  // already has one is skipped here as it always was, which is what makes
  // sending the whole session's lines on every reconciliation safe: the client
  // does not have to track which households it has already covered.
  const preferencesApplied = new Set<string>();
  let preferenceLinesApplied = 0;

  for (const referral of pickableReferrals) {
    if (coveredReferrals.has(referral.id)) continue;

    const resolved = resolveParcel(referral, grid, contentsByName);
    if ('reason' in resolved) {
      unresolvedHouseholdSizes.add(householdSize(referral));
      continue;
    }

    const preferences = preferencesByReferral.get(referral.id) ?? [];
    preferencesApplied.add(referral.id);
    preferenceLinesApplied += preferences.length;

    resolvedParcels.push({ referral, lines: mergePreferenceLines(resolved.lines, preferences) });
  }

  const preferenceReferralsIgnored = preferenceLines.filter(
    (entry) => !preferencesApplied.has(entry.referralId),
  ).length;

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
      // Likewise a snapshot. Only a parcel being created gets one, which is
      // what makes sending the whole session's information on every
      // reconciliation safe for a note a team leader has since edited.
      notes: notesByReferral.get(referral.id) ?? null,
      createdAt: now,
      updatedAt: now,
    });

    for (const line of lines) {
      lineRows.push({
        id: crypto.randomUUID(),
        parcelId,
        stockItemId: line.stockItemId,
        quantity: line.quantity,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // One native D1 batch: atomic, and json_each keeps it to three statements
  // however many parcels there are.
  if (existingPickList !== undefined && parcelRows.length === 0) {
    // The ordinary reconciliation: everybody already has a parcel. Preference
    // lines arrived for households that are already picked, so they are
    // reported as ignored rather than applied.
    return {
      pickList: existingPickList,
      parcelsCreated: 0,
      linesCreated: 0,
      preferenceLinesApplied: 0,
      preferenceLinesDropped,
      preferenceReferralsIgnored,
    };
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
        // The preference lines and the pick-list information go round with it.
        // A retry that dropped either would create parcels without the
        // household's preferences or without the note saying what they cannot
        // eat, and report success — the worst failure available here.
        return generatePickList(deps, sessionId, actor, {
          preferenceLines,
          pickListInformation,
          existingPickList: existing,
          attempts: attempts + 1,
        });
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
        return generatePickList(deps, sessionId, actor, {
          preferenceLines,
          pickListInformation,
          existingPickList: current,
          attempts: attempts + 1,
        });
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
    preferenceLinesApplied,
    preferenceLinesDropped,
    preferenceReferralsIgnored,
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
