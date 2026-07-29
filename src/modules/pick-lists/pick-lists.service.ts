import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ConflictError, NotFoundError } from '../../core/errors.ts';
import type { Logger } from '../../core/log.ts';
import type { Parcel, PickList } from '../../db/schema/pick-lists.ts';
import type { Referral } from '../../db/schema/referrals.ts';
import {
  generatePickList,
  type GenerationDeps,
  type GenerationResult,
} from './generation.service.ts';
import type { ParcelWithLines, PickListsRepository } from './pick-lists.repository.ts';

export interface PickListsServiceDeps extends GenerationDeps {
  readonly repository: PickListsRepository;
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

export function createPickListsService(deps: PickListsServiceDeps) {
  const { repository, referrals, clock, logger } = deps;

  async function getPickList(id: string): Promise<PickList> {
    const pickList = await repository.findById(id);
    if (pickList === undefined) {
      throw new NotFoundError('Pick list not found');
    }
    return pickList;
  }

  /**
   * The pick list for a session, generating it on first view.
   *
   * "Generated on first view" is the spec's wording, and it is also what makes
   * the timing right: the list reflects the referrals as they stood when
   * someone actually came to pick, not when the session was created.
   */
  async function getOrGenerate(sessionId: string, actor: Actor): Promise<GenerationResult> {
    const existing = await repository.findBySession(sessionId);
    if (existing !== undefined) {
      return { pickList: existing, parcelsCreated: 0, linesCreated: 0, skipped: [] };
    }
    return generatePickList(deps, sessionId, actor);
  }

  /** Editing is allowed while draft and after printing — but never once confirmed. */
  async function requireEditable(pickListId: string): Promise<PickList> {
    const pickList = await getPickList(pickListId);
    if (pickList.status === 'confirmed') {
      throw new ConflictError('This pick list has been confirmed and can no longer be changed');
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

  /** Adds an item or changes its quantity. Always marked `manual`. */
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
        source: 'manual',
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
   * Records that the list has been printed.
   *
   * Only the *first* print is stamped — reprinting a smudged sheet is not a
   * state change, and the spec explicitly allows edits after printing.
   */
  async function markPrinted(pickListId: string): Promise<PickList> {
    const pickList = await requireEditable(pickListId);
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
   * Confirms picking is finished and locks the list.
   *
   * **This does not move stock.** Stock moves when attendance is recorded,
   * because until someone turns up nothing has been given away.
   */
  async function confirm(pickListId: string, actor: Actor): Promise<PickList> {
    const pickList = await getPickList(pickListId);
    if (pickList.status === 'confirmed') return pickList; // Idempotent.

    const now = clock.nowIso();
    const updated = await repository.updatePickList(pickListId, {
      status: 'confirmed',
      confirmedAt: now,
      confirmedByUserId: actor.userId,
      updatedAt: now,
    });
    if (updated === undefined) {
      throw new NotFoundError('Pick list not found');
    }

    logger.info('confirmed pick list', { pickListId, userId: actor.userId });
    return updated;
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
        .filter((referral) => referral.status === 'active' && !covered.has(referral.id))
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
    getOrGenerate,
    listParcelsWithLines: (pickListId: string): Promise<ParcelWithLines[]> =>
      repository.listParcelsWithLines(pickListId),
    getParcel,
    setLine,
    removeLine,
    setParcelNotes,
    markPrinted,
    confirm,
    divergence,
    requireEditable,
  };
}

export type PickListsService = ReturnType<typeof createPickListsService>;
