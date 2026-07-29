import { devLoginSchema } from '../auth.schema.ts';
import type { IdentityClaim, IdentityProvider } from '../identity-provider.ts';

/**
 * Development-only identity provider.
 *
 * Per the spec, there is no validation: submit any email address and you are
 * that person. This is a stub to be replaced by Google OIDC.
 *
 * Two structural controls keep it from becoming a production incident, and
 * neither is enforced here — that is the point:
 *
 * 1. `auth.routes.ts` does not REGISTER the dev-login route unless
 *    `AUTH_MODE=dummy`. A runtime guard can be defeated by a middleware
 *    ordering mistake; a route that was never added cannot.
 * 2. `config/env.ts` refuses to start the Worker when `AUTH_MODE=dummy` and
 *    `ENVIRONMENT=production`.
 *
 * Consequence worth stating plainly: any deployment running this provider is
 * an open admin panel. Real referral data must never live in one.
 */
export function createDummyProvider(): IdentityProvider {
  return {
    name: 'dummy',
    autoProvisions: true,

    authenticate(input: unknown): Promise<IdentityClaim> {
      const parsed = devLoginSchema.parse(input);
      const email = parsed.email.trim().toLowerCase();

      return Promise.resolve({
        provider: 'dummy',
        subject: `dummy:${email}`,
        email,
        // Honest: nothing was verified. The flag exists so the Google provider
        // can set it truthfully and account linking can depend on it.
        emailVerified: false,
        displayName: parsed.displayName ?? email,
        // Lets a developer provision a team lead to exercise role boundaries.
        ...(parsed.role === undefined ? {} : { provisionRole: parsed.role }),
      });
    },
  };
}
