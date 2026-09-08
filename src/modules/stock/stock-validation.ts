/**
 * The non-blocking stock-consistency report behind `GET /stock/validation`.
 *
 * Pure and I/O-free: the service loads every item, crate and crate member and
 * hands them here as plain data. Nothing here writes anything or rejects
 * anything — see `stock.service.ts` and `crates.service.ts` for the write-time
 * rules a crate itself still has to satisfy at creation. This is drift that
 * only shows up after the fact: an item's shelf moving out from under its
 * crate, a grouping and a crate membership going out of sync, and so on.
 *
 * The six kinds are the stable vocabulary `GET /stock/validation` promises —
 * add to this list rather than changing what an existing kind means, since a
 * client may key UI off it.
 *
 * ## Retired items are outside this universe
 *
 * Every check here is about items the food bank is currently stocking. An item
 * with `isActive: false` is on no stock take, so it takes no part: it does not
 * make a shared shelf need a crate, it is not chased for a grouping it no
 * longer needs, and it never counts towards "counted exactly once". Retiring an
 * item that was a crate member leaves that crate alone — the membership row
 * stays exactly as saved and the crate stays valid (see `crate_too_few_members`
 * below) — so retiring an item is never a way to quietly break a crate, and the
 * record of what a crate contained is not rewritten each time one of its items
 * is retired. Reactivating the item resumes every check with its wiring intact.
 */

export const STOCK_VALIDATION_ISSUE_KINDS = [
  'shelf_without_crate',
  'crate_too_few_members',
  'crate_member_shelf_mismatch',
  'item_uncounted',
  'item_grouped_and_crate_member',
  'item_in_multiple_crates',
] as const;
export type StockValidationIssueKind = (typeof STOCK_VALIDATION_ISSUE_KINDS)[number];

export interface StockValidationIssue {
  readonly kind: StockValidationIssueKind;
  readonly message: string;
  readonly stockItemId?: string;
  readonly crateId?: string;
}

export interface ValidationItem {
  readonly id: string;
  readonly name: string;
  readonly shelfNumber: string;
  readonly groupingId: string | null;
  /** A retired item (`false`) is loaded so a crate member is still known to
   * exist, but takes no part in any check — see the module comment. */
  readonly isActive: boolean;
}

export interface ValidationCrate {
  readonly id: string;
  readonly name: string;
  readonly shelfKey: string;
}

export interface ValidationCrateMember {
  readonly crateId: string;
  readonly stockItemId: string;
}

export function computeStockValidationIssues(
  items: readonly ValidationItem[],
  crates: readonly ValidationCrate[],
  members: readonly ValidationCrateMember[],
): StockValidationIssue[] {
  // Retired items are dropped up front: every check below is about the current
  // stock-taking universe, and a retired item is not in it.
  const activeItems = items.filter((item) => item.isActive);
  const activeItemsById = new Map(activeItems.map((item) => [item.id, item]));
  const crateByShelfKey = new Map(crates.map((crate) => [crate.shelfKey, crate]));
  const membersByCrate = new Map<string, ValidationCrateMember[]>();
  const cratesByActiveItem = new Map<string, string[]>();

  for (const member of members) {
    pushInto(membersByCrate, member.crateId, member);
    if (activeItemsById.has(member.stockItemId)) {
      pushInto(cratesByActiveItem, member.stockItemId, member.crateId);
    }
  }

  const issues: StockValidationIssue[] = [];

  // 1. A shelf with more than one active item, but no crate claiming that shelf.
  const itemIdsByShelf = new Map<string, string[]>();
  for (const item of activeItems) pushInto(itemIdsByShelf, item.shelfNumber, item.id);
  for (const [shelfNumber, itemIds] of itemIdsByShelf) {
    if (itemIds.length > 1 && !crateByShelfKey.has(shelfNumber)) {
      issues.push({
        kind: 'shelf_without_crate',
        message: `Shelf ${shelfNumber} holds more than one stock item but no crate is set up for it.`,
      });
    }
  }

  // 2 & 3. Per crate: too few members, and each member whose item shelf has
  // drifted from the crate's own shelf key.
  for (const crate of crates) {
    const crateMembers = membersByCrate.get(crate.id) ?? [];
    // Membership rows, not active members: retiring a member must not push an
    // existing crate below its minimum and "invalidate" it. The membership
    // stands as saved until an administrator changes it.
    if (crateMembers.length < 2) {
      issues.push({
        kind: 'crate_too_few_members',
        crateId: crate.id,
        message: `Crate "${crate.name}" has fewer than two members.`,
      });
    }

    for (const member of crateMembers) {
      // Only active members are held to the crate's shelf: a retired member may
      // have been moved or consolidated without that being a drift to fix.
      const item = activeItemsById.get(member.stockItemId);
      if (item !== undefined && item.shelfNumber !== crate.shelfKey) {
        issues.push({
          kind: 'crate_member_shelf_mismatch',
          crateId: crate.id,
          stockItemId: item.id,
          message: `${item.name} is on shelf ${item.shelfNumber}, not crate "${crate.name}"'s shelf ${crate.shelfKey}.`,
        });
      }
    }
  }

  // 4, 5 & 6. Per active item: uncounted, both directly grouped and a crate
  // member, or a member of more than one crate.
  for (const item of activeItems) {
    const memberOfCrateIds = cratesByActiveItem.get(item.id) ?? [];
    const isCrateMember = memberOfCrateIds.length > 0;

    if (item.groupingId === null && !isCrateMember) {
      issues.push({
        kind: 'item_uncounted',
        stockItemId: item.id,
        message: `${item.name} has no grouping and is not a crate member, so it will not appear on a grouped stock take.`,
      });
    }

    if (item.groupingId !== null && isCrateMember) {
      issues.push({
        kind: 'item_grouped_and_crate_member',
        stockItemId: item.id,
        message: `${item.name} is both directly grouped and a crate member.`,
      });
    }

    if (memberOfCrateIds.length > 1) {
      issues.push({
        kind: 'item_in_multiple_crates',
        stockItemId: item.id,
        message: `${item.name} belongs to more than one crate.`,
      });
    }
  }

  return issues;
}

function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}
