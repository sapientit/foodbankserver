import { relations } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Roles.
 *
 * Three, and each is a different job rather than a rank. An administrator runs
 * the food bank, a team leader runs the sessions, and a fuel administrator
 * does one thing and sees nothing else at all. **`fuel_admin` is deliberately
 * not a variety of administrator** — it is the boundary that stops somebody
 * brought in to help with fuel bills reading why every household in the
 * borough was referred. See `INITIAL_SPEC1.txt`, #Roles.
 *
 * `volunteer` was here until 0018, enumerated speculatively on the reasoning
 * that adding a role later would cost a table rebuild. Adding `fuel_admin` was
 * that rebuild, so the speculation paid for nothing and the value went with
 * it. Do not add another on the same argument — see
 * `docs/engineering/d1-constraints.md`, which counts what guessing has cost
 * this schema already.
 */
export const USER_ROLES = ['admin', 'team_lead', 'fuel_admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * `replay_detected` is no longer written: a token presented after it was
 * rotated is refused without touching the rest of the family. It stays in the
 * list because it stays in the CHECK constraint — dropping a value costs a
 * table rebuild — and because rows written before that changed still carry it.
 */
export const REVOKED_REASONS = [
  'rotated',
  'logout',
  'replay_detected',
  'admin_revoked',
  'user_deactivated',
] as const;
export type RevokedReason = (typeof REVOKED_REASONS)[number];

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** Always stored lowercased — matching is case-insensitive. */
    email: text('email').notNull().unique(),
    displayName: text('display_name').notNull(),
    role: text('role').$type<UserRole>().notNull(),
    /**
     * The Google OIDC `sub`. Present from day one even though Google is not
     * wired up yet: that is what makes swapping the identity provider a config
     * change rather than a migration under time pressure.
     */
    googleSubject: text('google_subject').unique(),
    isActive: integer('is_active').notNull().default(1),
    lastLoginAt: text('last_login_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('users_role_valid', sql`${table.role} IN ('admin', 'team_lead', 'fuel_admin')`),
    check('users_is_active_boolean', sql`${table.isActive} IN (0, 1)`),
  ],
);

/**
 * Opaque, rotating refresh tokens.
 *
 * Only the SHA-256 hash is stored, so a database dump yields nothing usable.
 * Every use rotates: the old row is revoked and a new one issued in the same
 * `familyId`, inheriting its `expiresAt`. That inherited expiry is the
 * eight-hour sign-in cap — the row says when the sign-in ends, not when this
 * particular token would have, so rotation cannot extend it.
 *
 * Presenting an already-revoked token is refused and nothing else. The family
 * is only revoked wholesale by a logout or a deactivation, both of which are
 * somebody's decision rather than an inference from a repeated request.
 */
export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    familyId: text('family_id').notNull(),
    /** Epoch seconds, to match JWT `exp` and avoid parsing on the auth path. */
    issuedAt: integer('issued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    replacedById: text('replaced_by_id'),
    revokedReason: text('revoked_reason').$type<RevokedReason>(),
  },
  (table) => [
    index('idx_refresh_tokens_user').on(table.userId, table.expiresAt),
    index('idx_refresh_tokens_family').on(table.familyId),
    check(
      'refresh_tokens_revoked_reason_valid',
      sql`${table.revokedReason} IS NULL OR ${table.revokedReason} IN ('rotated', 'logout', 'replay_detected', 'admin_revoked', 'user_deactivated')`,
    ),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  refreshTokens: many(refreshTokens),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
