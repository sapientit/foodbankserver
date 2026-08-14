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
 * How much pick-list information a parcel may carry.
 *
 * Two of the form's longest permitted answers are 500 characters each, and the
 * client sends them with a label saying which is which — so 500 was never
 * enough to hold what the charity asks the form for. Enforced here and on the
 * PATCH that edits a note afterwards; both go through this constant so a note
 * accepted at generation can always be edited and put back.
 *
 * SQLite `TEXT` is unbounded, so this is the only limit there is: raising it
 * needs no migration, and lowering it would strand notes that already exist.
 */
export const PARCEL_NOTES_MAX_LENGTH = 1200;

/**
 * The free text shown beside a parcel and printed on its sheet.
 *
 * Trimmed before it is measured, so trailing whitespace never costs a
 * character.
 */
export const parcelNotesSchema = z.string().trim().max(PARCEL_NOTES_MAX_LENGTH);

/**
 * The optional body of a generate-or-reconcile request.
 *
 * The client evaluates its own preference rules against the referral answers
 * and sends the stock items it resolved them to — **ids, never names**, since
 * the server holds no form definition and must not start matching on text. It
 * composes the pick-list information out of those same answers for the same
 * reason, and sends the finished words.
 *
 * Duplicates are refused rather than merged, both here and at the referral
 * level. Two quantities for one item in one request is an ambiguous
 * instruction the server has no basis for resolving, and far more likely a
 * client bug than anyone's intent — the same reading as a stock-take page.
 */
export const generatePickListSchema = z.object({
  /**
   * The pick-list information the client composed for each referral, from the
   * form answers it marks as belonging on the sheet.
   *
   * Finished text, never answer keys: the server holds no form definition, and
   * the same reasoning that stops it matching stock items on names stops it
   * deciding which answers are picking information. Duplicates are refused
   * rather than concatenated, for the same reason a duplicate preference line
   * is — two notes for one household is an ambiguous instruction.
   */
  pickListInformation: z
    .array(
      z.object({
        referralId: z.uuid(),
        notes: parcelNotesSchema.min(1),
      }),
    )
    .max(100)
    .default([])
    .refine(
      (entries) => new Set(entries.map((entry) => entry.referralId)).size === entries.length,
      'the same referral must not appear twice',
    ),
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

/** Likewise `[]` when the request carried no body, or no annotations. */
export type PickListInformationSet = z.infer<typeof generatePickListSchema>['pickListInformation'];
