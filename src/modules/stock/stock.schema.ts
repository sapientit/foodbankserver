import { z } from 'zod';

/**
 * D1 caps a `LIKE`/`GLOB` pattern at **50 bytes**. Exceeding it is a runtime
 * SQL error, not an empty result, so the term is capped here rather than
 * discovered in production.
 */
export const MAX_SEARCH_TERM = 40;

export const stockItemInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(30),
  shelfNumber: z.string().trim().min(1).max(20),
  lowStockThreshold: z.number().int().min(0).max(100000).nullable().default(null),
});

export const stockItemPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    unit: z.string().trim().min(1).max(30),
    shelfNumber: z.string().trim().min(1).max(20),
    lowStockThreshold: z.number().int().min(0).max(100000).nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

export const stockSearchSchema = z.object({
  q: z.string().trim().min(1).max(MAX_SEARCH_TERM),
});

/** Recording a shop: one trip, many lines, each adding to existing stock. */
export const purchaseInputSchema = z.object({
  purchasedAt: z.iso.datetime().optional(),
  note: z.string().trim().max(500).nullable().default(null),
  lines: z
    .array(
      z.object({
        stockItemId: z.uuid(),
        quantity: z.number().int().positive().max(100000),
      }),
    )
    .min(1)
    .max(200),
});

export const stockTakeInputSchema = z.object({
  note: z.string().trim().max(500).nullable().default(null),
});

export const stockTakeCountsSchema = z.object({
  counts: z
    .array(
      z.object({
        stockItemId: z.uuid(),
        countedQuantity: z.number().int().min(0).max(100000),
      }),
    )
    .min(1)
    .max(500),
});

/** A manual correction always needs a reason — it is the only unexplained delta. */
export const stockAdjustmentSchema = z.object({
  stockItemId: z.uuid(),
  quantityDelta: z
    .number()
    .int()
    .refine((value) => value !== 0, 'must not be zero'),
  movementType: z.enum(['donation', 'wastage', 'expiry', 'correction', 'opening_balance']),
  reason: z.string().trim().min(1).max(300),
});
