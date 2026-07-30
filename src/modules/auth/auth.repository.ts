import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  refreshTokens,
  users,
  type RefreshTokenRow,
  type RevokedReason,
  type User,
} from '../../db/schema/users.ts';

/**
 * Storage for users and refresh tokens.
 *
 * Multi-write operations return *statement builders* rather than performing
 * the writes. D1 has no interactive transactions, so the service composes the
 * statements and executes exactly one `db.batch([...])`. See CLAUDE.md.
 */
export interface NewRefreshToken {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly familyId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export function createAuthRepository(db: Database) {
  return {
    async findUserByEmail(email: string): Promise<User | undefined> {
      const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return expectAtMostOne(rows);
    },

    async findUserByGoogleSubject(subject: string): Promise<User | undefined> {
      const rows = await db.select().from(users).where(eq(users.googleSubject, subject)).limit(1);
      return expectAtMostOne(rows);
    },

    async findUserById(id: string): Promise<User | undefined> {
      const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | undefined> {
      const rows = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(1);
      return expectAtMostOne(rows);
    },

    /**
     * Revokes every token in a family that is not already revoked.
     *
     * This is the replay response: one statement, so it cannot half-apply, and
     * it is naturally idempotent because already-revoked rows are excluded.
     */
    async revokeFamily(familyId: string, reason: RevokedReason, at: number): Promise<void> {
      await db
        .update(refreshTokens)
        .set({ revokedAt: at, revokedReason: reason })
        .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
    },

    // ---- Statement builders. Compose these, then run ONE db.batch(). ----

    buildInsertRefreshToken(token: NewRefreshToken) {
      return db.insert(refreshTokens).values({
        ...token,
        revokedAt: null,
        replacedById: null,
        revokedReason: null,
      });
    },

    buildRevokeToken(id: string, reason: RevokedReason, at: number, replacedById: string | null) {
      return db
        .update(refreshTokens)
        .set({ revokedAt: at, revokedReason: reason, replacedById })
        .where(eq(refreshTokens.id, id));
    },

    buildTouchLastLogin(userId: string, at: string) {
      return db.update(users).set({ lastLoginAt: at, updatedAt: at }).where(eq(users.id, userId));
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
