import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users.ts';

/**
 * Stock-take volunteer codes.
 *
 * A team lead hands a volunteer a code to count the shelves with, instead of
 * an account the volunteer would never otherwise need. The code reaches the
 * grouped stock take and nothing else — not the item list, not a correction,
 * not anything with a household's name on it (see `INITIAL_SPEC1.txt`,
 * #Stock maintenance and #Login). It lasts fourteen days
 * (`VOLUNTEER_CODE_TTL_SECONDS`); nothing ends one sooner, and generating
 * another leaves earlier codes valid to their own expiry. Lapsed rows are
 * swept only when the next code is generated, so a lapsed row can linger in
 * the table — but it is never surfaced ("nothing is kept once it has
 * lapsed"): `authenticate` refuses it and `findLatestActive` filters it out.
 *
 * Only the SHA-256 hash of the normalised code is stored, exactly as refresh
 * tokens are — a database dump yields nothing usable. The code is 80 bits of
 * randomness, not a chosen secret, so plain SHA-256 is right and a KDF would
 * only burn Worker CPU.
 *
 * `createdByUserId` is who a count made on the code is recorded against: the
 * team lead chose to hand the counting over, and that is the decision with a
 * name on it.
 */
export const volunteerCodes = sqliteTable('volunteer_codes', {
  id: text('id').primaryKey(),
  codeHash: text('code_hash').notNull().unique(),
  createdByUserId: text('created_by_user_id')
    .notNull()
    .references(() => users.id),
  /** Epoch seconds, matching the refresh-token expiries and JWT `exp`. */
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export type VolunteerCodeRow = typeof volunteerCodes.$inferSelect;
export type NewVolunteerCode = typeof volunteerCodes.$inferInsert;
