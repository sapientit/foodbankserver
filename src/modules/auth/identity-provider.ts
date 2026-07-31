import type { AppConfig } from '../../config/env.ts';

/**
 * What an identity provider tells us about whoever just authenticated.
 *
 * Everything downstream of this type — user resolution, token issuance,
 * rotation, replay detection, the middleware — is identical whether the claim
 * came from the dummy provider or from Google. That is the whole point: adding
 * Google means adding one file that produces one of these, not touching the
 * auth flow.
 *
 * One thing that is not in this file has to be done in the same change: the
 * seeded first admin in `migrations/0007_bootstrap-admin.sql` is a stand-in
 * address and is replaced when Google arrives.
 */
export interface IdentityClaim {
  readonly provider: 'dummy' | 'google';
  /** Stable provider-side identifier. For Google this is the OIDC `sub`. */
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string;
}

export interface IdentityProvider {
  readonly name: 'dummy' | 'google';
  /**
   * Turns whatever the provider was given into a claim.
   *
   * A claim is only an assertion of identity. **No provider may create an
   * account**: the role, and access at all, come from the `users` table, which
   * only an admin writes. See `resolveUser` in `auth.service.ts`.
   */
  authenticate(input: unknown): Promise<IdentityClaim>;
}

export type IdentityProviderFactory = (config: AppConfig) => IdentityProvider;
