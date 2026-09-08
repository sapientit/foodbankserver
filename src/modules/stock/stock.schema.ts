import { z } from 'zod';

/**
 * D1 caps a `LIKE`/`GLOB` pattern at **50 bytes**. Exceeding it is a runtime
 * SQL error, not an empty result, so the term is capped here rather than
 * discovered in production.
 */
export const MAX_SEARCH_TERM = 40;

/**
 * A category is short — it is a heading on a screen, not a sentence — and a
 * description is one line beside the name on a printed sheet. Both caps are
 * generous for that and small enough that neither can turn a pick list into
 * something that will not fit on a page.
 */
export const MAX_CATEGORY = 40;
export const MAX_DESCRIPTION = 200;

/**
 * The ceiling on a direct stock-take count. Also the ceiling `stock.service.ts`
 * holds a crate-decomposed quantity to — `sizePerCrate * enteredCount` is not
 * itself bounded this tightly, so without that second check a large crate
 * could write a ledger delta a direct count could never produce.
 */
export const MAX_COUNTED_QUANTITY = 100000;

/**
 * `groupingId` is nullable so an item can be explicitly cleared to `null` on
 * patch — the state a crate member is expected to be in. `unitsPerPack` and
 * `packUnitLabel` are likewise nullable so either can be cleared. See
 * `stock.service.ts` for the normalisation between the two: `packUnitLabel`
 * is forced to `null` whenever `unitsPerPack` is absent.
 */
export const stockItemInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(MAX_CATEGORY),
  description: z.string().trim().max(MAX_DESCRIPTION).optional(),
  shelfNumber: z.string().trim().min(1).max(20),
  lowStockThreshold: z.number().int().min(0).max(100000).nullable().optional(),
  groupingId: z.uuid().nullable().optional(),
  unitsPerPack: z.number().int().min(1).max(100000).nullable().optional(),
  packUnitLabel: z.string().trim().max(40).nullable().optional(),
});

export const stockItemPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(MAX_CATEGORY),
    // Nullable, unlike the rest: a description is the one field here that can
    // be taken away as well as changed, and `null` is how a client says so.
    description: z.string().trim().max(MAX_DESCRIPTION).nullable(),
    shelfNumber: z.string().trim().min(1).max(20),
    isActive: z.boolean(),
    // Nullable too: clearing the threshold is how a client stops watching an
    // item, and `null` is how it says so — same pattern as `description`.
    lowStockThreshold: z.number().int().min(0).max(100000).nullable(),
    groupingId: z.uuid().nullable(),
    unitsPerPack: z.number().int().min(1).max(100000).nullable(),
    packUnitLabel: z.string().trim().max(40).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

/**
 * How a list of stock items is ordered.
 *
 * Two orders, because the screens genuinely want different ones: maintenance
 * and pick-list amendment group by category and read alphabetically inside it,
 * while the stock take and the printed pick list follow the shelves so that a
 * volunteer walks the warehouse once.
 */
export const STOCK_ORDERS = ['category', 'shelf'] as const;
export type StockOrder = (typeof STOCK_ORDERS)[number];

export const stockOrderSchema = z.enum(STOCK_ORDERS);

export const stockSearchSchema = z.object({
  q: z.string().trim().min(1).max(MAX_SEARCH_TERM),
});

/**
 * One saved page of a stock take.
 *
 * `counts` carries **only the items the volunteer changed**; an item left alone
 * is left out and is not touched. 200 is not the page size — the client picks
 * that, and 40 is what the screen shows — it is a ceiling on one request.
 *
 * A count of zero is legitimate and means the shelf is empty. It is the reason
 * `countedQuantity` is `min(0)` rather than positive.
 *
 * `crateCounts` counts a crate as one line; the server decomposes it into the
 * same per-item deltas a direct count would produce — see
 * `crate-decomposition.ts`. Its numeric shape mirrors a crate *target* line:
 * one decimal place, settled by Pete on 2026-09-05 (was Q50) — a half-empty
 * crate on a shelf is plausible.
 */
export const stockTakeCountsSchema = z
  .object({
    counts: z
      .array(
        z.object({
          stockItemId: z.uuid(),
          countedQuantity: z.number().int().min(0).max(MAX_COUNTED_QUANTITY),
        }),
      )
      .max(200)
      // Two counts for one item in one page is a genuinely ambiguous
      // instruction, and the server has no basis for picking the later one. It
      // is far more likely to be a client bug than a volunteer's intent.
      .refine(
        (counts) => new Set(counts.map((count) => count.stockItemId)).size === counts.length,
        'the same stock item must not appear twice',
      )
      .default([]),
    crateCounts: z
      .array(
        z.object({
          crateId: z.uuid(),
          enteredCount: z.number().min(0).max(100000).multipleOf(0.1),
        }),
      )
      .max(200)
      .refine(
        (crateCounts) =>
          new Set(crateCounts.map((count) => count.crateId)).size === crateCounts.length,
        'the same crate must not appear twice',
      )
      .default([]),
  })
  .refine(
    (value) => value.counts.length > 0 || value.crateCounts.length > 0,
    'at least one changed direct or crate count must be supplied',
  );

/**
 * A team lead's hand correction to one item's level, between one stock take
 * and the next. Unlike `stockTakeCountsSchema`'s `countedQuantity`, this is
 * not a fresh total the server reconciles against the ledger — it is the
 * signed amount the level is out by, applied directly.
 */
export const stockCorrectionSchema = z.object({
  quantityDelta: z
    .number()
    .int()
    .min(-MAX_COUNTED_QUANTITY)
    .max(MAX_COUNTED_QUANTITY)
    .refine((value) => value !== 0, 'quantityDelta must not be zero'),
});
