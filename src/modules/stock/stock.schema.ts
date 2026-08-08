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

export const stockItemInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(MAX_CATEGORY),
  description: z.string().trim().max(MAX_DESCRIPTION).optional(),
  shelfNumber: z.string().trim().min(1).max(20),
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
 */
export const stockTakeCountsSchema = z.object({
  counts: z
    .array(
      z.object({
        stockItemId: z.uuid(),
        countedQuantity: z.number().int().min(0).max(100000),
      }),
    )
    .min(1)
    .max(200)
    // Two counts for one item in one page is a genuinely ambiguous
    // instruction, and the server has no basis for picking the later one. It
    // is far more likely to be a client bug than a volunteer's intent.
    .refine(
      (counts) => new Set(counts.map((count) => count.stockItemId)).size === counts.length,
      'the same stock item must not appear twice',
    ),
});
