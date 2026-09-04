import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import {
  NEEDS_ATTENTION_QUANTITY,
  type Parcel,
  type PickList,
} from '../../db/schema/pick-lists.ts';
import { REFERRAL_STATUSES_HOLDING_A_PLACE, type Referral } from '../../db/schema/referrals.ts';
import type { Session } from '../../db/schema/sessions.ts';
import { instantToLondonWallClock } from '../../core/time/london.ts';
import { startOfWeek } from '../../core/time/plain-date.ts';
import type { VoucherConfigRepository } from '../voucher-config/voucher-config.repository.ts';
import type { VoucherDateRange } from '../voucher-config/derivations.ts';
import {
  generatePickList,
  type GenerationDeps,
  type GenerationResult,
} from './generation.service.ts';
import type { ParcelWithLines, PickListsRepository } from './pick-lists.repository.ts';
import type { PickListInformationSet, PreferenceLineSet } from './pick-lists.schema.ts';
import type { StockOrder } from '../stock/stock.schema.ts';
import {
  stockRequirementLines,
  stockRequirementSummaryLines,
  type StockRequirementLine,
  type StockRequirementSummaryLine,
} from './stock-requirement.ts';

export interface PickListsServiceDeps extends GenerationDeps {
  readonly repository: PickListsRepository;
  readonly voucherConfig: VoucherConfigRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * How a pick list has drifted from the referrals it was generated from.
 *
 * Reported rather than auto-applied: a picker may already be holding the
 * printed sheet, so an admin decides whether to act. Deliberately mirrors the
 * rules versioning — nothing changes a list that already exists without
 * someone asking for it.
 */
export interface PickListDivergence {
  /** Active referrals that arrived after generation and have no parcel. */
  readonly missingParcels: string[];
  /** Parcels whose referral has since changed household size. */
  readonly changedHouseholds: {
    parcelId: string;
    was: { adults: number; children: number };
    now: { adults: number; children: number };
  }[];
  /** Parcels whose referral has since been cancelled. */
  readonly cancelledReferrals: string[];
}

/**
 * Printing is refused while any parcel still needs a team leader's decision:
 * an unreviewed parcel on a sheet becomes a bag on a table.
 */
const UNREVIEWED_PARCEL = 'Review every parcel on this pick list before printing it';

export function createPickListsService(deps: PickListsServiceDeps) {
  const { repository, referrals, sessions, stock, voucherConfig, clock } = deps;

  async function getPickList(id: string): Promise<PickList> {
    const pickList = await repository.findById(id);
    if (pickList === undefined) {
      throw new NotFoundError('Pick list not found');
    }
    return pickList;
  }

  async function getPickListForSession(sessionId: string): Promise<PickList> {
    const pickList = await repository.findBySession(sessionId);
    if (pickList === undefined) {
      throw new NotFoundError('Pick list not found');
    }
    return pickList;
  }

  /**
   * The pick list for a session, generating it on first view and reconciling
   * any active referral that arrived since.
   */
  async function getOrGenerate(
    sessionId: string,
    actor: Actor,
    input: {
      preferenceLines: PreferenceLineSet;
      pickListInformation: PickListInformationSet;
    },
  ): Promise<GenerationResult> {
    const { preferenceLines, pickListInformation } = input;
    const existing = await repository.findBySession(sessionId);
    if (existing !== undefined) {
      return generatePickList(deps, sessionId, actor, {
        preferenceLines,
        pickListInformation,
        existingPickList: existing,
      });
    }
    return generatePickList(deps, sessionId, actor, { preferenceLines, pickListInformation });
  }

  /** Editing is allowed while draft and after printing — locked once the session is confirmed. */
  async function requireEditable(pickListId: string): Promise<PickList> {
    const pickList = await getPickList(pickListId);
    const session = await sessions.findById(pickList.sessionId);
    if (session === undefined) {
      throw new NotFoundError('Session not found');
    }
    if (session.status === 'confirmed') {
      throw new ConflictError('This session has been confirmed and can no longer be changed');
    }
    return pickList;
  }

  async function getParcel(parcelId: string): Promise<Parcel> {
    const parcel = await repository.findParcelById(parcelId);
    if (parcel === undefined) {
      throw new NotFoundError('Parcel not found');
    }
    return parcel;
  }

  /**
   * Adds an item or changes its quantity.
   *
   * The route admits `0` and above only, so this is also how a team leader
   * settles a needs-attention line: a positive quantity replaces it, `0`
   * removes it. There is no way to *create* a `-1` from here — those arrive
   * from the client's preference rules at generation and nowhere else.
   */
  async function setLine(parcelId: string, stockItemId: string, quantity: number): Promise<void> {
    const parcel = await getParcel(parcelId);
    await requireEditable(parcel.pickListId);

    const now = clock.nowIso();
    if (quantity <= 0) {
      await repository.deleteLine(parcelId, stockItemId);
    } else {
      await repository.upsertLine({
        id: crypto.randomUUID(),
        parcelId,
        stockItemId,
        quantity,
        createdAt: now,
        updatedAt: now,
      });
    }

    await repository.updateParcel(parcelId, { updatedAt: now });
  }

  async function removeLine(parcelId: string, stockItemId: string): Promise<void> {
    const parcel = await getParcel(parcelId);
    await requireEditable(parcel.pickListId);

    await repository.deleteLine(parcelId, stockItemId);
    await repository.updateParcel(parcelId, { updatedAt: clock.nowIso() });
  }

  async function setParcelNotes(parcelId: string, notes: string | null): Promise<Parcel> {
    const parcel = await getParcel(parcelId);
    await requireEditable(parcel.pickListId);

    const updated = await repository.updateParcel(parcelId, {
      notes,
      updatedAt: clock.nowIso(),
    });
    if (updated === undefined) {
      throw new NotFoundError('Parcel not found');
    }
    return updated;
  }

  /**
   * Marks the checked parcel ready for printing and its attendance outcome.
   * Idempotent.
   *
   * Refused while any line still says `NEEDS_ATTENTION_QUANTITY`. **This single
   * check is what keeps an unsettled line off a sheet and out of the stock
   * ledger**: printing waits for every parcel to be reviewed, attendance waits
   * for this parcel to be reviewed, and `-1` can only be created at generation,
   * on a parcel that is by definition new and unreviewed. Weaken it and a `-1`
   * reaches `buildParcelIssue`, which negates the quantity — so a line meaning
   * "somebody must decide" would silently *add* one to stock.
   */
  async function markParcelReviewed(parcelId: string): Promise<Parcel> {
    const parcel = await getParcel(parcelId);
    await requireEditable(parcel.pickListId);

    const lines = await repository.listLinesFor(parcelId);
    if (lines.some((line) => line.quantity === NEEDS_ATTENTION_QUANTITY)) {
      throw new ConflictError('Settle every item needing attention before reviewing this parcel');
    }

    if (parcel.reviewedAt !== null) return parcel;
    const updated = await repository.updateParcel(parcelId, {
      reviewedAt: clock.nowIso(),
      updatedAt: clock.nowIso(),
    });
    if (updated === undefined) throw new NotFoundError('Parcel not found');
    return updated;
  }

  /**
   * The parcels a print request may put on paper.
   *
   * Reads the same rows the payload is built from rather than counting
   * separately, because the print route has no query to spare.
   *
   * **A cancelled parcel is neither printed nor waited for.** Its household is
   * not coming, so a sheet for it is a bag packed for nobody — and holding the
   * whole session's printing until somebody reviews a parcel that will never be
   * picked would be worse still. The row itself stays: it is the record of what
   * had been prepared, and `GET .../pick-list` still returns it.
   */
  async function listParcelsForPrint(pickListId: string): Promise<ParcelWithLines[]> {
    const entries = (await repository.listParcelsWithLines(pickListId)).filter(
      (entry) => entry.parcel.attendance !== 'cancelled',
    );
    if (entries.some((entry) => entry.parcel.reviewedAt === null)) {
      throw new ConflictError(UNREVIEWED_PARCEL);
    }
    return entries;
  }

  /**
   * What `toPrintParcelResponse` needs beyond the parcels themselves: the
   * session's own date, to compare against the voucher range, and the range
   * itself. Read fresh on every call — see `PrintParcelResponse` on why this
   * is never cached alongside the pick list.
   */
  async function printContext(
    pickList: PickList,
  ): Promise<{ session: Session; voucherRange: VoucherDateRange | undefined }> {
    const session = await sessions.findById(pickList.sessionId);
    if (session === undefined) {
      throw new NotFoundError('Session not found');
    }
    const config = await voucherConfig.find();

    return {
      session,
      voucherRange:
        config === undefined ? undefined : { startDate: config.startDate, endDate: config.endDate },
    };
  }

  /**
   * Records that the list has been printed.
   *
   * Only the *first* print is stamped — reprinting a smudged sheet is not a
   * state change, and the spec explicitly allows edits after printing. The
   * review check still runs on a reprint: a late referral reconciled in since
   * the first print arrives unreviewed, and it must not reach paper either.
   */
  async function markPrinted(pickListId: string): Promise<PickList> {
    const pickList = await requireEditable(pickListId);

    const parcelRows = await repository.listParcels(pickListId);
    // Cancelled parcels are excluded for the same reason they are left off the
    // payload — see `listParcelsForPrint`.
    if (
      parcelRows.some((parcel) => parcel.reviewedAt === null && parcel.attendance !== 'cancelled')
    ) {
      throw new ConflictError(UNREVIEWED_PARCEL);
    }

    if (pickList.status === 'printed') return pickList;

    const now = clock.nowIso();
    const updated = await repository.updatePickList(pickListId, {
      status: 'printed',
      firstPrintedAt: pickList.firstPrintedAt ?? now,
      updatedAt: now,
    });
    if (updated === undefined) {
      throw new NotFoundError('Pick list not found');
    }
    return updated;
  }

  /**
   * What the session will take off the shelves, item by item, against what is
   * on them.
   *
   * Only the items the session's parcels actually call for: the whole
   * catalogue with a hundred blank lines in it is the stock-take screen, not
   * this one.
   *
   * **Every parcel must have been reviewed** — the same point printing waits
   * for, and for the same reason. A reviewed parcel is one a team leader has
   * settled, so the quantities on it are decided; an unreviewed one may still
   * be carrying a line saying somebody has to choose, and there is no honest
   * total to add that up into.
   *
   * `quantityOnHand` is the level *now*, so a parcel already marked attended
   * has come off it while still counting towards the requirement — the figure
   * is what the session as a whole asks for, not what is left to pick.
   *
   * **Refused once the session itself is confirmed.** Confirming records every
   * attended household's parcel against `quantityOnHand`, so by the time a
   * session is confirmed that stock has already left the shelf while the
   * parcel still counts towards this figure — the comparison would be a
   * finished session measured against a shelf nobody can still act on. Checked
   * first, ahead of the review and needs-attention gates below: a confirmed
   * session cannot have an unreviewed or unsettled parcel on it either (both
   * are required before attendance can be recorded), so this can never mask
   * either of those — it is simply the cheaper, more final reason to refuse.
   *
   * Five queries: the session, the pick list, its parcels, the totals, and the
   * catalogue.
   */
  async function stockRequirement(
    sessionId: string,
    order: StockOrder,
  ): Promise<{ pickList: PickList; lines: StockRequirementLine[] }> {
    const pickList = await getPickListForSession(sessionId);

    const session = await sessions.findById(pickList.sessionId);
    if (session === undefined) {
      throw new NotFoundError('Session not found');
    }
    if (session.status === 'confirmed') {
      throw new ConflictError(
        'This session has been confirmed, so it can no longer be compared against stock',
      );
    }

    // Cancelled parcels are neither reviewed nor counted — the household is
    // not coming, so waiting on a review for one would hold the whole session's
    // figure for a parcel nobody will ever pick. Same rule as printing.
    const parcelRows = await repository.listParcels(pickList.id);
    if (
      parcelRows.some((parcel) => parcel.reviewedAt === null && parcel.attendance !== 'cancelled')
    ) {
      throw new ConflictError(
        'Review every parcel on this pick list before comparing it against stock',
      );
    }

    const required = await repository.sumRequiredByItem(pickList.id);
    // A backstop rather than the main gate: reviewing a parcel already refuses
    // while it holds a `-1`, and nothing can put one back afterwards. It stays
    // because it costs one column of a query that was being run anyway, and
    // because a `-1` reaching this sum does not fail — it quietly takes one off
    // what the warehouse is told to find, which nobody would notice.
    if (required.some((entry) => entry.lowestQuantity === NEEDS_ATTENTION_QUANTITY)) {
      throw new ConflictError(
        'Settle every item needing attention before comparing this pick list against stock',
      );
    }

    // The whole catalogue, inactive items included: an item deactivated after
    // generation is still in parcels and still has to be found on a shelf.
    const levels = await stock.listLevels(false, order);

    return {
      pickList,
      lines: stockRequirementLines(
        levels,
        new Map(required.map((entry) => [entry.stockItemId, entry.requiredQuantity])),
      ),
    };
  }

  /**
   * The running total of what every session still to come, up to a cut-off
   * date, is going to need — `INITIAL_SPEC1.txt`, `#Stock requirement report`.
   *
   * An admin's planning report, not the per-session comparison above, and
   * deliberately simpler in three ways: it spans every not-yet-confirmed
   * session in the window rather than one, it does not wait for every parcel
   * to be reviewed — most of the sessions it covers have not been picked
   * yet, so a review gate would mean the total never appears in time to plan
   * against — and it has no stock level to compare against, so there is no
   * `quantityOnHand` and no `shortfall`, only a required quantity. A `-1`
   * line is filtered out of the sum rather than refused, the same treatment
   * the fresh-food shopping list gives it.
   *
   * **The window has a floor as well as `upToDate`: the start of the current
   * week.** Not exposed as a parameter — the caller only ever asks for
   * `upToDate` — because it is a scope decision, not a filter anybody
   * chooses per call: the report is about sessions still being planned for,
   * and a session nobody confirmed years ago sitting in the total forever
   * would be a stale figure nobody would think to doubt. See
   * `sumRequiredUpTo` for what this floor also does for the query's cost.
   */
  async function stockRequirementSummary(
    upToDate: string,
    order: StockOrder,
  ): Promise<StockRequirementSummaryLine[]> {
    const today = instantToLondonWallClock(clock.nowIso()).date;
    const required = await repository.sumRequiredUpTo(startOfWeek(today), upToDate);

    // The whole catalogue, inactive items included — same reasoning as
    // `stockRequirement`: an item deactivated after generation is still in
    // parcels and still has to be picked.
    const levels = await stock.listLevels(false, order);

    return stockRequirementSummaryLines(
      levels,
      new Map(required.map((entry) => [entry.stockItemId, entry.requiredQuantity])),
    );
  }

  /** Compares the list against the referrals as they stand now. */
  async function divergence(pickList: PickList): Promise<PickListDivergence> {
    const [parcelRows, current] = await Promise.all([
      repository.listParcels(pickList.id),
      referrals.list({ sessionId: pickList.sessionId }),
    ]);

    const byReferral = new Map(current.map((referral: Referral) => [referral.id, referral]));
    const covered = new Set(parcelRows.map((parcel) => parcel.referralId));

    return {
      missingParcels: current
        .filter(
          (referral) =>
            REFERRAL_STATUSES_HOLDING_A_PLACE.some((status) => status === referral.status) &&
            !covered.has(referral.id),
        )
        .map((referral) => referral.id),

      changedHouseholds: parcelRows.flatMap((parcel) => {
        const referral = byReferral.get(parcel.referralId);
        if (referral === undefined) return [];
        if (referral.adults === parcel.adults && referral.children === parcel.children) return [];

        return [
          {
            parcelId: parcel.id,
            was: { adults: parcel.adults, children: parcel.children },
            now: { adults: referral.adults, children: referral.children },
          },
        ];
      }),

      cancelledReferrals: parcelRows
        .filter((parcel) => byReferral.get(parcel.referralId)?.status === 'cancelled')
        .map((parcel) => parcel.id),
    };
  }

  return {
    getPickList,
    getPickListForSession,
    getOrGenerate,
    listParcelsWithLines: (pickListId: string): Promise<ParcelWithLines[]> =>
      repository.listParcelsWithLines(pickListId),
    getParcel,
    listParcelsForPrint,
    printContext,
    setLine,
    removeLine,
    setParcelNotes,
    markParcelReviewed,
    markPrinted,
    stockRequirement,
    stockRequirementSummary,
    divergence,
    requireEditable,
  };
}

export type PickListsService = ReturnType<typeof createPickListsService>;
