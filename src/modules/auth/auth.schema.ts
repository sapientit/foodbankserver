import { z } from 'zod';
import { USER_ROLES } from '../../db/schema/users.ts';

/**
 * The dev-login body.
 *
 * Parsing the shape is not the same as validating the identity — the dummy
 * provider deliberately accepts any address, as specified. This only ensures
 * we were handed a string that looks like an email rather than an object.
 */
export const devLoginSchema = z.object({
  email: z.email().max(254),
  displayName: z.string().min(1).max(120).optional(),
  /** Lets a developer log in as a team lead to exercise role boundaries. */
  role: z.enum(USER_ROLES).optional(),
});

export type DevLoginInput = z.infer<typeof devLoginSchema>;

export interface TokenResponse {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: string;
  };
}
