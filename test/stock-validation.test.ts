import { describe, expect, it } from 'vitest';
import {
  computeStockValidationIssues,
  type ValidationCrate,
  type ValidationCrateMember,
  type ValidationItem,
} from '../src/modules/stock/stock-validation.ts';

const active = (item: Omit<ValidationItem, 'isActive'>): ValidationItem => ({
  ...item,
  isActive: true,
});
const retired = (item: Omit<ValidationItem, 'isActive'>): ValidationItem => ({
  ...item,
  isActive: false,
});

describe('computeStockValidationIssues', () => {
  it('flags a shelf holding more than one item when no crate claims that shelf (shelf_without_crate)', () => {
    const items: ValidationItem[] = [
      active({ id: 'i1', name: 'Beans', shelfNumber: 'S1', groupingId: 'g1' }),
      active({ id: 'i2', name: 'Peas', shelfNumber: 'S1', groupingId: 'g1' }),
    ];

    const issues = computeStockValidationIssues(items, [], []);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('shelf_without_crate');
  });

  it('flags a crate with fewer than two members (crate_too_few_members)', () => {
    const items: ValidationItem[] = [
      active({ id: 'i1', name: 'Beans', shelfNumber: 'S1', groupingId: null }),
    ];
    const crates: ValidationCrate[] = [{ id: 'c1', name: 'Solo Crate', shelfKey: 'S1' }];
    const members: ValidationCrateMember[] = [{ crateId: 'c1', stockItemId: 'i1' }];

    const issues = computeStockValidationIssues(items, crates, members);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('crate_too_few_members');
  });

  it('flags a crate member whose item shelf has drifted from the crate shelf key (crate_member_shelf_mismatch)', () => {
    const items: ValidationItem[] = [
      active({ id: 'i1', name: 'Beans', shelfNumber: 'S2', groupingId: null }),
      active({ id: 'i2', name: 'Peas', shelfNumber: 'S1', groupingId: null }),
    ];
    const crates: ValidationCrate[] = [{ id: 'c1', name: 'Crate', shelfKey: 'S1' }];
    const members: ValidationCrateMember[] = [
      { crateId: 'c1', stockItemId: 'i1' },
      { crateId: 'c1', stockItemId: 'i2' },
    ];

    const issues = computeStockValidationIssues(items, crates, members);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'crate_member_shelf_mismatch',
      crateId: 'c1',
      stockItemId: 'i1',
    });
  });

  it('flags an item with no grouping that is also not a crate member (item_uncounted)', () => {
    const items: ValidationItem[] = [
      active({ id: 'i1', name: 'Beans', shelfNumber: 'S1', groupingId: null }),
    ];

    const issues = computeStockValidationIssues(items, [], []);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('item_uncounted');
  });

  it('flags an item that is both directly grouped and a crate member (item_grouped_and_crate_member)', () => {
    const items: ValidationItem[] = [
      active({ id: 'i1', name: 'Beans', shelfNumber: 'S1', groupingId: 'g1' }),
      active({ id: 'i2', name: 'Peas', shelfNumber: 'S1', groupingId: null }),
    ];
    const crates: ValidationCrate[] = [{ id: 'c1', name: 'Crate', shelfKey: 'S1' }];
    const members: ValidationCrateMember[] = [
      { crateId: 'c1', stockItemId: 'i1' },
      { crateId: 'c1', stockItemId: 'i2' },
    ];

    const issues = computeStockValidationIssues(items, crates, members);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'item_grouped_and_crate_member', stockItemId: 'i1' });
  });

  it('flags an item belonging to more than one crate (item_in_multiple_crates)', () => {
    const items: ValidationItem[] = [
      active({ id: 'i1', name: 'Beans', shelfNumber: 'S1', groupingId: null }),
      active({ id: 'i2', name: 'Peas', shelfNumber: 'S1', groupingId: null }),
      active({ id: 'i3', name: 'Sweetcorn', shelfNumber: 'S1', groupingId: null }),
    ];
    const crates: ValidationCrate[] = [
      { id: 'c1', name: 'Crate One', shelfKey: 'S1' },
      { id: 'c2', name: 'Crate Two', shelfKey: 'S1' },
    ];
    const members: ValidationCrateMember[] = [
      { crateId: 'c1', stockItemId: 'i1' },
      { crateId: 'c1', stockItemId: 'i2' },
      { crateId: 'c2', stockItemId: 'i1' },
      { crateId: 'c2', stockItemId: 'i3' },
    ];

    const issues = computeStockValidationIssues(items, crates, members);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'item_in_multiple_crates', stockItemId: 'i1' });
  });

  it('reports no issues for a fully consistent stock list', () => {
    const items: ValidationItem[] = [
      // Directly grouped, alone on its shelf, not a crate member.
      active({ id: 'i1', name: 'Beans', shelfNumber: 'A1', groupingId: 'g1' }),
      // A two-member crate whose shelf matches, each member ungrouped and a
      // member of exactly one crate.
      active({ id: 'i2', name: 'Pasta', shelfNumber: 'B1', groupingId: null }),
      active({ id: 'i3', name: 'Rice', shelfNumber: 'B1', groupingId: null }),
    ];
    const crates: ValidationCrate[] = [{ id: 'c1', name: 'Dry Goods Crate', shelfKey: 'B1' }];
    const members: ValidationCrateMember[] = [
      { crateId: 'c1', stockItemId: 'i2' },
      { crateId: 'c1', stockItemId: 'i3' },
    ];

    const issues = computeStockValidationIssues(items, crates, members);

    expect(issues).toEqual([]);
  });

  describe('retired items are outside the crate-validation universe', () => {
    it('does not require a crate for a shelf where an active item and a retired item sit together', () => {
      // Active "Flour" and its retired predecessor "Flour: SR" share a shelf.
      const items: ValidationItem[] = [
        active({ id: 'flour', name: 'Flour', shelfNumber: 'S1', groupingId: 'g1' }),
        retired({ id: 'flour-sr', name: 'Flour: SR', shelfNumber: 'S1', groupingId: 'g1' }),
      ];

      const issues = computeStockValidationIssues(items, [], []);

      expect(issues).toEqual([]);
    });

    it('does not report a retired ungrouped, uncrated item as item_uncounted', () => {
      const items: ValidationItem[] = [
        retired({ id: 'flour-sr', name: 'Flour: SR', shelfNumber: 'S1', groupingId: null }),
      ];

      const issues = computeStockValidationIssues(items, [], []);

      expect(issues).toEqual([]);
    });

    it('keeps a two-member crate valid after one member is retired (no crate_too_few_members)', () => {
      const items: ValidationItem[] = [
        active({ id: 'i1', name: 'Rice', shelfNumber: 'B1', groupingId: null }),
        retired({ id: 'i2', name: 'Old Rice', shelfNumber: 'B1', groupingId: null }),
      ];
      const crates: ValidationCrate[] = [{ id: 'c1', name: 'Dry Goods Crate', shelfKey: 'B1' }];
      const members: ValidationCrateMember[] = [
        { crateId: 'c1', stockItemId: 'i1' },
        { crateId: 'c1', stockItemId: 'i2' },
      ];

      const issues = computeStockValidationIssues(items, crates, members);

      expect(issues).toEqual([]);
    });

    it('does not chase a retired crate member for shelf drift or a grouped-and-member conflict', () => {
      const items: ValidationItem[] = [
        active({ id: 'i1', name: 'Rice', shelfNumber: 'B1', groupingId: null }),
        active({ id: 'i2', name: 'Pasta', shelfNumber: 'B1', groupingId: null }),
        // Retired, moved off the crate's shelf, and still directly grouped.
        retired({ id: 'i3', name: 'Old Pasta', shelfNumber: 'Z9', groupingId: 'g1' }),
      ];
      const crates: ValidationCrate[] = [{ id: 'c1', name: 'Dry Goods Crate', shelfKey: 'B1' }];
      const members: ValidationCrateMember[] = [
        { crateId: 'c1', stockItemId: 'i1' },
        { crateId: 'c1', stockItemId: 'i2' },
        { crateId: 'c1', stockItemId: 'i3' },
      ];

      const issues = computeStockValidationIssues(items, crates, members);

      expect(issues).toEqual([]);
    });

    it('does not report a retired item that sits in more than one crate', () => {
      const items: ValidationItem[] = [
        active({ id: 'a1', name: 'Beans', shelfNumber: 'S1', groupingId: null }),
        active({ id: 'a2', name: 'Peas', shelfNumber: 'S1', groupingId: null }),
        active({ id: 'a3', name: 'Corn', shelfNumber: 'S2', groupingId: null }),
        retired({ id: 'r1', name: 'Old Beans', shelfNumber: 'S1', groupingId: null }),
      ];
      const crates: ValidationCrate[] = [
        { id: 'c1', name: 'Crate One', shelfKey: 'S1' },
        { id: 'c2', name: 'Crate Two', shelfKey: 'S2' },
      ];
      const members: ValidationCrateMember[] = [
        { crateId: 'c1', stockItemId: 'a1' },
        { crateId: 'c1', stockItemId: 'a2' },
        { crateId: 'c1', stockItemId: 'r1' },
        { crateId: 'c2', stockItemId: 'a3' },
        { crateId: 'c2', stockItemId: 'r1' },
      ];

      const issues = computeStockValidationIssues(items, crates, members);

      expect(issues).toEqual([]);
    });

    it('still flags active-member drift and duplicate membership when a retired member is also present', () => {
      const items: ValidationItem[] = [
        active({ id: 'i1', name: 'Rice', shelfNumber: 'Z9', groupingId: null }),
        active({ id: 'i2', name: 'Pasta', shelfNumber: 'B1', groupingId: null }),
        retired({ id: 'i3', name: 'Old Rice', shelfNumber: 'B1', groupingId: null }),
      ];
      const crates: ValidationCrate[] = [{ id: 'c1', name: 'Dry Goods Crate', shelfKey: 'B1' }];
      const members: ValidationCrateMember[] = [
        { crateId: 'c1', stockItemId: 'i1' },
        { crateId: 'c1', stockItemId: 'i2' },
        { crateId: 'c1', stockItemId: 'i3' },
      ];

      const issues = computeStockValidationIssues(items, crates, members);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        kind: 'crate_member_shelf_mismatch',
        crateId: 'c1',
        stockItemId: 'i1',
      });
    });
  });
});
