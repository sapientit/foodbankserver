import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { referralReasons } from './referrers.ts';
import { sessions } from './sessions.ts';
import { users } from './users.ts';

/**
 * One row per `importKey` ever submitted to `POST /dev-test/referral-imports`
 * — the client's test-data loader, not a real referral source. See
 * `dev-test-imports.service.ts`.
 *
 * **What this table is for.** D1 has no interactive transaction, so
 * `importKey` idempotency cannot be a read-then-decide in TypeScript: two
 * calls racing the same key would both pass a "does it exist yet?" check.
 * `import_key` is the primary key instead, so the second of two racing
 * inserts fails the batch on a unique violation and the service reads this
 * row back to decide what to do — replay the stored result if the request
 * matches, refuse with a `409` if it does not. The same shape the stock
 * ledger's parcel/movement guard uses for the same reason.
 *
 * **These two columns hold nothing the purge needs to reach — but only
 * because of what they are, not because the request behind them is provably
 * anonymised.** `result_json` holds only ids and a count (see
 * `ImportResult`); `request_hash` is a one-way SHA-256 digest, not a stored
 * copy of anything, so it cannot be read back into a name or address. Only
 * `referrerEmail` is schema-restricted to `example.test`
 * (`dev-test.schema.ts`) — the referee's own fields (name, date of birth,
 * address, postcode, phone) and `answers` carry no such restriction, and an
 * admin submitting a real household's details here creates an ordinary
 * `referrals` row, subject to the ordinary purge, exactly like any other
 * referral. This route trusts the caller to send prepared, anonymised
 * scenarios; it does not itself enforce that they are.
 */
export const referralImports = sqliteTable('referral_imports', {
  importKey: text('import_key').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  reasonId: text('reason_id')
    .notNull()
    .references(() => referralReasons.id),
  /**
   * SHA-256 (hex) of the validated request — `sessionId`, `reasonId` and
   * every prepared referral, in the order Zod returns them. A repeat call
   * with a matching hash is the same import run twice; a mismatch means the
   * key was reused for a different request, which is refused rather than
   * silently replayed or silently re-imported.
   */
  requestHash: text('request_hash').notNull(),
  /** The response this import produced, replayed verbatim on a repeat call. */
  resultJson: text('result_json').notNull(),
  /** Who ran the import. No purge ever reaches this table, so kept plainly. */
  createdByUserId: text('created_by_user_id').references(() => users.id),
  createdAt: text('created_at').notNull(),
});

export type ReferralImport = typeof referralImports.$inferSelect;
export type NewReferralImport = typeof referralImports.$inferInsert;
