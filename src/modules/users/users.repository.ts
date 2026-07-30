import { and, asc, eq, sql } from 'drizzle-orm';
import type { Patch } from '../../core/types.ts';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import { users, type NewUser, type User } from '../../db/schema/users.ts';

/**
 * Storage for user administration.
 *
 * `auth.repository.ts` reads the same table on the login path. The overlap is
 * deliberate: each module owns the queries it needs, and neither reaches into
 * the other's repository.
 */
export function createUsersRepository(db: Database) {
  return {
    async list(activeOnly: boolean): Promise<User[]> {
      return db
        .select()
        .from(users)
        .where(activeOnly ? eq(users.isActive, 1) : undefined)
        .orderBy(asc(users.email));
    },

    async findById(id: string): Promise<User | undefined> {
      const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    async insert(user: NewUser): Promise<User> {
      const rows = await db.insert(users).values(user).returning();
      const inserted = rows[0];
      if (inserted === undefined) throw new Error('Failed to insert user');
      return inserted;
    },

    async update(id: string, patch: Patch<NewUser>): Promise<User | undefined> {
      const rows = await db.update(users).set(patch).where(eq(users.id, id)).returning();
      return expectAtMostOne(rows);
    },

    /**
     * Applies the patch **only if somebody else is still an active admin**,
     * and reports whether it did.
     *
     * D1 has no interactive transactions, so counting the admins in the
     * service and then writing would let two concurrent demotions each see the
     * other and lock everyone out. The condition therefore travels with the
     * write, as one statement SQLite evaluates atomically.
     */
    async updateLeavingAnotherAdmin(id: string, patch: Patch<NewUser>): Promise<User | undefined> {
      const rows = await db
        .update(users)
        .set(patch)
        .where(
          and(
            eq(users.id, id),
            sql`EXISTS (SELECT 1 FROM ${users} AS other
                        WHERE other.id <> ${id} AND other.role = 'admin' AND other.is_active = 1)`,
          ),
        )
        .returning();
      return expectAtMostOne(rows);
    },
  };
}

export type UsersRepository = ReturnType<typeof createUsersRepository>;
