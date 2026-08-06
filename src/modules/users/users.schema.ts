import { z } from 'zod';

/**
 * The roles an admin may hand out.
 *
 * All three, since 0018 removed the speculative `volunteer` and the database
 * now enumerates exactly the roles that have routes. So this list and
 * `USER_ROLES` currently say the same thing.
 *
 * **They stay two constants all the same.** "What the database will store" and
 * "what an administrator may pick from a dropdown" are different questions,
 * and they have already diverged once: a role can exist in the schema before
 * any route grants it anything, and offering that one here would create
 * accounts that sign in and can do nothing. Collapsing them would lose the
 * place to say so.
 */
export const ASSIGNABLE_ROLES = ['admin', 'team_lead', 'fuel_admin'] as const;
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
