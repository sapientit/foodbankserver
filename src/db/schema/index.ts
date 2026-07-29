/**
 * The Drizzle schema. `drizzle-kit generate` reads this file and writes SQL
 * into `migrations/`, which is also where wrangler applies from — so the
 * migrations the tests run against are exactly the ones production gets.
 *
 * SQLite conventions used throughout (see CLAUDE.md):
 * - IDs are `TEXT` UUIDv4.
 * - Timestamps are ISO-8601 UTC `TEXT`; token and key expiries are epoch
 *   `INTEGER`, to match JWT `exp` and avoid parsing on the auth hot path.
 * - Booleans are `INTEGER` constrained to 0/1.
 * - Enums are CHECK constraints, enumerated generously — SQLite cannot alter
 *   a CHECK constraint without rebuilding the table.
 */
export * from './forms.ts';
export * from './jobs.ts';
export * from './pick-lists.ts';
export * from './referrals.ts';
export * from './referrers.ts';
export * from './rules.ts';
export * from './sessions.ts';
export * from './stock.ts';
export * from './users.ts';
