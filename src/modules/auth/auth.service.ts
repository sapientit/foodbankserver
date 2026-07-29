import { REFRESH_TOKEN_TTL_SECONDS } from '../../config/constants.ts';
import type { Actor } from '../../core/actor.ts';
import type { Clock } from '../../core/clock.ts';
import { ForbiddenError, UnauthorizedError } from '../../core/errors.ts';
import { mintSecret, sha256Hex } from '../../core/crypto/tokens.ts';
import type { Logger } from '../../core/log.ts';
import type { Database } from '../../db/client.ts';
import type { User, UserRole } from '../../db/schema/users.ts';
import type { AuthRepository } from './auth.repository.ts';
import type { IdentityClaim, IdentityProvider } from './identity-provider.ts';
import { signAccessToken } from './token.service.ts';

export interface IssuedTokens {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: number;
  /** Plaintext, returned to the client once. Only its hash is stored. */
  readonly refreshToken: string;
  readonly user: User;
}

export interface AuthServiceDeps {
  readonly db: Database;
  readonly repository: AuthRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly jwtSecret: string;
}

export function createAuthService(deps: AuthServiceDeps) {
  const { db, repository, clock, logger, jwtSecret } = deps;

  /**
   * Maps a provider claim to a user row.
   *
   * Match on the provider subject first, then on email — that second step is
   * account linking, and it back-fills `googleSubject` so subsequent logins
   * take the fast path. An unknown email is rejected unless the provider
   * auto-provisions, which only the dummy one does.
   */
  async function resolveUser(claim: IdentityClaim, provider: IdentityProvider): Promise<User> {
    if (claim.provider === 'google') {
      const bySubject = await repository.findUserByGoogleSubject(claim.subject);
      if (bySubject !== undefined) return assertActive(bySubject);
    }

    const byEmail = await repository.findUserByEmail(claim.email);
    if (byEmail !== undefined) return assertActive(byEmail);

    if (!provider.autoProvisions) {
      // Deliberately the same error as a bad credential: whether an address is
      // registered here is not something an unauthenticated caller should learn.
      logger.warn('rejected login for unknown account');
      throw new UnauthorizedError('Authentication failed');
    }

    const now = clock.nowIso();
    const created = await repository.insertUser({
      id: crypto.randomUUID(),
      email: claim.email,
      displayName: claim.displayName,
      role: defaultRoleFor(claim),
      googleSubject: null,
      isActive: 1,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });

    logger.info('auto-provisioned user', { userId: created.id, actorRole: created.role });
    return created;
  }

  /** Signs an access token and stores a fresh refresh-token family. */
  async function issueTokens(user: User): Promise<IssuedTokens> {
    const issuedAt = clock.nowEpochSeconds();
    const refreshToken = mintSecret();

    const { token: accessToken, expiresAt } = await signAccessToken(
      { userId: user.id, email: user.email, role: user.role },
      jwtSecret,
      clock,
    );

    await db.batch([
      repository.buildInsertRefreshToken({
        id: crypto.randomUUID(),
        userId: user.id,
        tokenHash: await sha256Hex(refreshToken),
        familyId: crypto.randomUUID(),
        issuedAt,
        expiresAt: issuedAt + REFRESH_TOKEN_TTL_SECONDS,
      }),
      repository.buildTouchLastLogin(user.id, clock.nowIso()),
    ]);

    return { accessToken, accessTokenExpiresAt: expiresAt, refreshToken, user };
  }

  /**
   * Exchanges a refresh token for a new pair, rotating it.
   *
   * Presenting a token that has already been revoked means it was either
   * stolen and replayed, or the client is buggy. Either way the whole family
   * is revoked — the OAuth 2.0 Security BCP defence, and the only meaningful
   * theft protection available without a server-side session store.
   */
  async function rotate(presented: string): Promise<IssuedTokens> {
    const now = clock.nowEpochSeconds();
    const existing = await repository.findRefreshTokenByHash(await sha256Hex(presented));

    if (existing === undefined) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    if (existing.revokedAt !== null) {
      logger.warn('refresh token replay detected; revoking family', { userId: existing.userId });
      await repository.revokeFamily(existing.familyId, 'replay_detected', now);
      throw new UnauthorizedError('Invalid refresh token');
    }

    if (existing.expiresAt <= now) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    const user = await repository.findUserById(existing.userId);
    if (user?.isActive !== 1) {
      await repository.revokeFamily(existing.familyId, 'user_deactivated', now);
      throw new UnauthorizedError('Invalid refresh token');
    }

    const nextId = crypto.randomUUID();
    const nextToken = mintSecret();

    const { token: accessToken, expiresAt } = await signAccessToken(
      { userId: user.id, email: user.email, role: user.role },
      jwtSecret,
      clock,
    );

    // Revoke-then-insert as one batch. There is no transaction to fall back
    // on, so these must not be two round trips.
    await db.batch([
      repository.buildRevokeToken(existing.id, 'rotated', now, nextId),
      repository.buildInsertRefreshToken({
        id: nextId,
        userId: user.id,
        tokenHash: await sha256Hex(nextToken),
        familyId: existing.familyId,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_SECONDS,
      }),
    ]);

    return { accessToken, accessTokenExpiresAt: expiresAt, refreshToken: nextToken, user };
  }

  /** Ends the session by revoking the whole family, not just the presented token. */
  async function logout(presented: string): Promise<void> {
    const existing = await repository.findRefreshTokenByHash(await sha256Hex(presented));
    if (existing === undefined) return; // Already gone; nothing to report.

    await repository.revokeFamily(existing.familyId, 'logout', clock.nowEpochSeconds());
  }

  async function login(input: unknown, provider: IdentityProvider): Promise<IssuedTokens> {
    const claim = await provider.authenticate(input);
    const user = await resolveUser(claim, provider);
    return issueTokens(user);
  }

  return { login, issueTokens, rotate, logout, resolveUser };
}

export type AuthService = ReturnType<typeof createAuthService>;

function assertActive(user: User): User {
  if (user.isActive !== 1) {
    throw new ForbiddenError('This account has been deactivated');
  }
  return user;
}

/**
 * Auto-provisioned users default to admin.
 *
 * Only the dummy provider provisions, and a developer stub that could not
 * reach the admin surface would be useless. `provisionRole` lets a developer
 * ask for a team lead instead, to exercise role boundaries. Real users are
 * created by an admin, with an explicit role.
 */
function defaultRoleFor(claim: IdentityClaim): UserRole {
  return claim.provisionRole ?? 'admin';
}

export function toActor(user: User): Actor {
  return { userId: user.id, email: user.email, role: user.role };
}
