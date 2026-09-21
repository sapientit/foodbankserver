import { z } from 'zod';

/**
 * The dev-login body.
 *
 * Parsing the shape is not the same as validating the identity — the dummy
 * provider deliberately accepts any address, as specified. This only ensures
 * we were handed a string that looks like an email rather than an object.
 *
 * The address is all it takes, because it is all that is used: the display
 * name and the role belong to the `users` row an admin created, and a login
 * may not override either.
 */
export const devLoginSchema = z.object({
  email: z.email().max(254),
});

export type DevLoginInput = z.infer<typeof devLoginSchema>;

/**
 * The Google sign-in body: the ID token Google Identity Services handed the
 * browser, and nothing else. Verifying it — signature, issuer, audience,
 * expiry, and the charity's Workspace domain — is `google-provider.ts`'s job;
 * this only ensures we were handed a non-empty string to verify.
 */
export const googleLoginSchema = z.object({
  idToken: z.string().min(1),
});

export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;

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
