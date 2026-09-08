import type { Clock } from '../../core/clock.ts';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.ts';
import { isUniqueViolation } from '../../db/unique-violation.ts';
import type { Crate, NewCrateMember } from '../../db/schema/crates.ts';
import type { Patch } from '../../core/types.ts';
import type { CrateInput, CratePatchInput } from './crates.schema.ts';
import type { CratesRepository, CrateWithMembers } from './crates.repository.ts';

export interface CratesServiceDeps {
  readonly repository: CratesRepository;
  readonly clock: Clock;
}

/**
 * Crate writes hard-validate: a crate cannot be born (or amended into) fewer
 * than two members, an unknown grouping, or a percentage table that does not
 * total 100 — all rejected here or by `crateInputSchema`/`cratePatchSchema`
 * before this is even called. This is deliberately different from stock-item
 * writes, which are never blocked on crate consistency — see
 * `stock-validation.ts` for the non-blocking report that catches drift these
 * checks cannot (an item's shelf moving out from under its crate afterwards,
 * for instance).
 */
export function createCratesService({ repository, clock }: CratesServiceDeps) {
  async function listCrates(): Promise<CrateWithMembers[]> {
    return repository.listCratesWithMembers();
  }

  /**
   * Every stock item id currently a member of any crate. `target-stock-
   * lists.service.ts` calls this across the module boundary — through this
   * service, never `crates.repository.ts` directly — to refuse a new
   * individual target on an item the crate is what gets bought for instead.
   */
  async function listMemberStockItemIds(): Promise<ReadonlySet<string>> {
    const crates = await repository.listCratesWithMembers();
    return new Set(crates.flatMap((entry) => entry.members.map((member) => member.stockItemId)));
  }

  async function assertGroupingExists(groupingId: string): Promise<void> {
    if (!(await repository.groupingExists(groupingId))) {
      throw new BadRequestError('Unknown grouping');
    }
  }

  async function assertMembersExist(members: readonly { stockItemId: string }[]): Promise<void> {
    const missing = await repository.missingStockItemIds(members.map((m) => m.stockItemId));
    if (missing.length > 0) {
      throw new BadRequestError('One or more crate members are not known stock items');
    }
  }

  function toNewMembers(crateId: string, input: CrateInput['members']): NewCrateMember[] {
    return input.map((member) => ({
      crateId,
      stockItemId: member.stockItemId,
      stockCompositionPercent: member.stockCompositionPercent,
      shoppingCompositionPercent: member.shoppingCompositionPercent,
    }));
  }

  async function createCrate(input: CrateInput): Promise<CrateWithMembers> {
    await assertGroupingExists(input.groupingId);
    await assertMembersExist(input.members);
    const now = clock.nowIso();
    const id = crypto.randomUUID();

    let crate: Crate;
    try {
      crate = await repository.insertCrateWithMembers(
        {
          id,
          name: input.name,
          shelfKey: input.shelfKey,
          groupingId: input.groupingId,
          sizePerCrate: input.sizePerCrate,
          createdAt: now,
          updatedAt: now,
        },
        toNewMembers(id, input.members),
      );
    } catch (error) {
      if (isUniqueViolation(error, 'crates.shelf_key')) {
        throw new ConflictError('A crate on that shelf already exists', { cause: error });
      }
      throw error;
    }

    return { crate, members: await repository.findMembersByCrateId(id) };
  }

  async function updateCrate(id: string, input: CratePatchInput): Promise<CrateWithMembers> {
    if (input.groupingId !== undefined) await assertGroupingExists(input.groupingId);
    if (input.members !== undefined) await assertMembersExist(input.members);

    const patch: Patch<Crate> = { updatedAt: clock.nowIso() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.shelfKey !== undefined) patch.shelfKey = input.shelfKey;
    if (input.groupingId !== undefined) patch.groupingId = input.groupingId;
    if (input.sizePerCrate !== undefined) patch.sizePerCrate = input.sizePerCrate;

    let updated: Crate | undefined;
    try {
      updated = await repository.updateCrateWithMembers(
        id,
        patch,
        input.members === undefined ? undefined : toNewMembers(id, input.members),
      );
    } catch (error) {
      if (isUniqueViolation(error, 'crates.shelf_key')) {
        throw new ConflictError('A crate on that shelf already exists', { cause: error });
      }
      throw error;
    }

    if (updated === undefined) {
      throw new NotFoundError('Crate not found');
    }
    return { crate: updated, members: await repository.findMembersByCrateId(id) };
  }

  async function deleteCrate(id: string): Promise<void> {
    await repository.deleteCrate(id); // Idempotent — deleting twice is not an error.
  }

  return { listCrates, listMemberStockItemIds, createCrate, updateCrate, deleteCrate };
}

export type CratesService = ReturnType<typeof createCratesService>;
