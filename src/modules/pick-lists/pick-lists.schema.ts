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
 * How long a parcel's note may be.
 *
 * The note now holds only the `No longer stocked: …` line the client writes at
 * generation; the rest of the pick-list information is composed by the client
 * on every showing and never stored. The limit dates from when the note held
 * all of it, and is kept rather than lowered because it costs nothing and a
 * historic release can name several items that no longer resolve.
 *
 * SQLite `TEXT` is unbounded, so this is the only limit there is.
 */
export const PARCEL_NOTES_MAX_LENGTH = 1200;

/** Trimmed before it is measured, so trailing whitespace never costs a character. */
export const parcelNotesSchema = z.string().trim().max(PARCEL_NOTES_MAX_LENGTH);

/**
 * The optional body of a generate-or-reconcile request.
 *
 * The client evaluates its own preference rules against the referral answers
 * and sends the stock items it resolved them to — **ids, never names**, since
 * the server keeps the form's releases but never reads them and must not start
 * matching on text.
 *
 * Duplicates are refused rather than merged, both here and at the referral
 * level. Two quantities for one item in one request is an ambiguous
 * instruction the server has no basis for resolving, and far more likely a
 * client bug than anyone's intent — the same reading as a stock-take page.
 */
export const generatePickListSchema = z.object({
  /**
   * The parcel note for each referral that needs one — which is now only a
   * referral whose historic release named stock that no longer resolves, and
   * the note is just the `No longer stocked: …` line. The rest of the pick-list
   * information is composed by the client every time it is shown, from the
   * referral's `picklistAdmin` and its marked answers, and is not sent here.
   *
   * Finished text, never answer keys: the server keeps the form's releases but
   * never reads them. Duplicates are refused rather than concatenated, for the
   * same reason a duplicate preference line is — two notes for one household
   * is an ambiguous instruction.
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
