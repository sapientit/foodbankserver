import { z } from 'zod';

/**
 * The roles an admin may hand out.
 *
 * The database enumerates `volunteer` as well, deliberately — SQLite cannot
 * extend a CHECK constraint without rebuilding the table. But no route grants
 * a volunteer anything, so offering it here would create accounts that can log
 * in and then do nothing. Add it when a route needs it.
 */
export const ASSIGNABLE_ROLES = ['admin', 'team_lead'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const userInputSchema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(ASSIGNABLE_ROLES),
});

/**
 * Email is not amendable.
 *
 * It is the login identity: every provider resolves an account by matching on
 * it, and it is what the audit trail means by "who". Repointing it would move
 * that history onto a different person. Deactivate and create instead.
 */
export const userPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    role: z.enum(ASSIGNABLE_ROLES),
    isActive: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field must be supplied');

export type UserInput = z.infer<typeof userInputSchema>;
export type UserPatch = z.infer<typeof userPatchSchema>;
