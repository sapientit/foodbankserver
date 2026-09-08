import { z } from 'zod';

/** A heading on a screen, same order of magnitude as `category`. */
export const MAX_GROUPING_NAME = 40;

export const groupingInputSchema = z.object({
  name: z.string().trim().min(1).max(MAX_GROUPING_NAME),
});

export const groupingPatchSchema = groupingInputSchema;
