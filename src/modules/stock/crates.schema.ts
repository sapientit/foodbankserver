import { z } from 'zod';

export const MAX_CRATE_NAME = 120;
export const MAX_SHELF_KEY = 20;

/**
 * `crates.repository.ts` inserts a crate's members with a plain Drizzle
 * multi-row `INSERT`, not the raw-D1/`json_each` pattern reserved for
 * `stock.repository.ts`/`pick-lists.repository.ts` — crate membership is
 * small enough not to need it, but only while it stays small. Each member row
 * binds 4 columns, and D1 caps a statement at 100 bound parameters, so this
 * is held comfortably under `100 / 4 = 25` rather than at the edge of it.
 */
export const MAX_CRATE_MEMBERS = 20;

/**
 * Percentages are integers, like every other quantity in this system — see
 * `CLAUDE.md`'s "quantities are integers... never floats". A member's share
 * is whole percentage points.
 */
const crateMemberInputSchema = z.object({
  stockItemId: z.uuid(),
  stockCompositionPercent: z.number().int().min(0).max(100),
  shoppingCompositionPercent: z.number().int().min(0).max(100),
});

/**
 * Both percentage tables total **exactly** 100 across a crate's members, and
 * there is no all-zero fallback — a crate that does not yet have its shares
 * worked out is rejected, not silently accepted with every member at 0%.
 */
const membersSchema = z
  .array(crateMemberInputSchema)
  .min(2, 'a crate needs at least two members')
  .max(MAX_CRATE_MEMBERS)
  .refine(
    (members) => new Set(members.map((member) => member.stockItemId)).size === members.length,
    'the same stock item must not appear twice in one crate',
  )
  .refine(
    (members) => members.reduce((sum, member) => sum + member.stockCompositionPercent, 0) === 100,
    'stock composition percentages must total exactly 100',
  )
  .refine(
    (members) =>
      members.reduce((sum, member) => sum + member.shoppingCompositionPercent, 0) === 100,
    'shopping composition percentages must total exactly 100',
  );

export const crateInputSchema = z.object({
  name: z.string().trim().min(1).max(MAX_CRATE_NAME),
  shelfKey: z.string().trim().min(1).max(MAX_SHELF_KEY),
  groupingId: z.uuid(),
  sizePerCrate: z.number().int().min(1).max(100_000),
  members: membersSchema,
});

export const cratePatchSchema = crateInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

export type CrateMemberInput = z.infer<typeof crateMemberInputSchema>;
export type CrateInput = z.infer<typeof crateInputSchema>;
export type CratePatchInput = z.infer<typeof cratePatchSchema>;
