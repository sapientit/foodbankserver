import { z } from 'zod';
import { NEEDS_ATTENTION_QUANTITY } from '../../db/schema/pick-lists.ts';

/**
 * A quantity the client's preference rules resolved, or `-1` for an item those
 * rules could not put a number on and a team leader must settle.
 */
const preferenceQuantitySchema = z
  .number()
  .int()
  .max(1000)
  .refine(
    (quantity) => quantity > 0 || quantity === NEEDS_ATTENTION_QUANTITY,
    'must be a positive quantity, or -1 for an item needing a team leader decision',
  );

/**
 * The optional body of a generate-or-reconcile request.
 *
 * The client evaluates its own preference rules against the referral answers
 * and sends the stock items it resolved them to — **ids, never names**, since
 * the server holds no form definition and must not start matching on text.
 *
 * Duplicates are refused rather than merged, both here and at the referral
 * level. Two quantities for one item in one request is an ambiguous
 * instruction the server has no basis for resolving, and far more likely a
 * client bug than anyone's intent — the same reading as a stock-take page.
 */
export const generatePickListSchema = z.object({
  preferenceLines: z
    .array(
      z.object({
        referralId: z.uuid(),
        lines: z
          .array(z.object({ stockItemId: z.uuid(), quantity: preferenceQuantitySchema }))
          .min(1)
          .max(100)
          .refine(
            (lines) => new Set(lines.map((line) => line.stockItemId)).size === lines.length,
            'the same stock item must not appear twice for one referral',
          ),
      }),
    )
    .max(100)
    .default([])
    .refine(
      (entries) => new Set(entries.map((entry) => entry.referralId)).size === entries.length,
      'the same referral must not appear twice',
    ),
});

/** What the service receives: `[]` when the request carried no body at all. */
export type PreferenceLineSet = z.infer<typeof generatePickListSchema>['preferenceLines'];
