import type { AppConfig } from '../../config/env.ts';
import type { UserRole } from '../../db/schema/users.ts';

/**
 * What an identity provider tells us about whoever just authenticated.
 *
 * Everything downstream of this type — user resolution, token issuance,
 * rotation, replay detection, the middleware — is identical whether the claim
 * came from the dummy provider or from Google. That is the whole point: adding
 * Google means adding one file that produces one of these, not touching the
 * auth flow.
 */
export interface IdentityClaim {
  readonly provider: 'dummy' | 'google';
  /** Stable provider-side identifier. For Google this is the OIDC `sub`. */
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string;
  /**
   * Role to give a newly provisioned user. Consulted **only** when the
   * provider auto-provisions, and ignored entirely for an existing user —
   * whose role lives in the database and is an admin's decision, not a
   * login-time claim.
   */
  readonly provisionRole?: UserRole;
}

export interface IdentityProvider {
  readonly name: 'dummy' | 'google';
  /**
   * Whether an unknown email may be turned into a new user.
   *
   * True only for the dummy provider, where the point is to be able to log in
   * as anyone without seeding. Google must be false: a verified Google account
   * proves who someone is, not that this food bank has given them access.
   */
  readonly autoProvisions: boolean;
  authenticate(input: unknown): Promise<IdentityClaim>;
}

export type IdentityProviderFactory = (config: AppConfig) => IdentityProvider;
