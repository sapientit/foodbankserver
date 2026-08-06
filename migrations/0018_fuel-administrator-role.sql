-- Roles become three: administrator, team leader and fuel administrator.
-- See `INITIAL_SPEC1.txt`, #Roles.
--
-- `fuel_admin` is a boundary rather than a job title. The account reaches
-- `GET /api/v1/fuel-help-list` and `GET /api/v1/auth/me` and nothing else, so
-- that somebody brought in to help with fuel bills cannot read why every
-- household in the borough was referred. A value has to be in this CHECK
-- before it can be in a row, so the role starts here.
--
-- `volunteer` goes in the same rebuild. 0001 enumerated it speculatively, on
-- the reasoning that adding a role later would cost a migration — which is the
-- migration this is. The speculation bought nothing and left a value no route
-- grants anything. **No row is expected to hold it.** If one does, the
-- re-insert below violates the new CHECK and the whole migration rolls back,
-- which is the right failure: nothing here may silently re-grade somebody's
-- access.
--
-- ## Why this is a rebuild, and why it is in this order
--
-- SQLite has no DROP CONSTRAINT, so changing `users_role_valid` means
-- rebuilding the table, and `users` has never been rebuilt. **Read
-- `migrations/0008`'s header before this one**; it is the worked example and
-- it documents both traps.
--
-- First: `drizzle-kit` wraps a rebuild in `PRAGMA foreign_keys=OFF`, which is
-- a **silent no-op on D1** — SQLite ignores that pragma inside a transaction
-- and D1 runs statements in implicit ones. `PRAGMA defer_foreign_keys=on` is
-- D1's documented equivalent: violations are still counted, just not checked
-- until the transaction ends.
--
-- Second: deferring alone is not enough. SQLite tracks a *counter* of
-- outstanding violations. Dropping a parent increments it once per child row,
-- and **only an insert back into the parent** brings it down. Copying rows
-- into `__new_users` before the drop never touches the counter, so the
-- generated ordering commits with it positive and rolls back with
-- `FOREIGN KEY constraint failed`.
--
-- `users` is the parent of **ten** foreign keys — `refresh_tokens.user_id`,
-- `sessions.confirmed_by_user_id`, `referrals.reviewed_by_user_id`,
-- `referrals.created_by_user_id`, `audit_events.actor_user_id`,
-- `pick_lists.generated_by_user_id`, `pick_lists.confirmed_by_user_id`,
-- `parcels.attendance_recorded_by_user_id`, `stock_ledger.actor_user_id` and
-- `sms_messages.sent_by_user_id` — more children than any parent rebuilt here
-- before. Hence: park the rows in a plain table, rebuild, rename, and only
-- then insert them back, so the inserts land in the table those ten keys now
-- point at and settle the counter before commit.
--
-- ## The one thing this destroys
--
-- **Exactly one of those ten cascades.** `refresh_tokens.user_id` is
-- `ON DELETE cascade` (0001), and the implicit `DELETE FROM users` inside
-- `DROP TABLE` still performs foreign key *actions* — `defer_foreign_keys`
-- defers the *checks*, not the actions. So running this deletes every refresh
-- token and **signs everybody out**. There is no ordering that avoids it.
--
-- The system is not live, so the cost today is nobody. On a live deployment it
-- would be every signed-in volunteer having to sign in again mid-session, and
-- this would have to run out of hours. It is written down because the next
-- person to rebuild `users` will not learn it from the schema.
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
CREATE TABLE `__old_users` AS SELECT "id", "email", "display_name", "role", "google_subject", "is_active", "last_login_at", "created_at", "updated_at" FROM `users`;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`google_subject` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`last_login_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "users_role_valid" CHECK("__new_users"."role" IN ('admin', 'team_lead', 'fuel_admin')),
	CONSTRAINT "users_is_active_boolean" CHECK("__new_users"."is_active" IN (0, 1))
);
--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
INSERT INTO `users`("id", "email", "display_name", "role", "google_subject", "is_active", "last_login_at", "created_at", "updated_at") SELECT "id", "email", "display_name", "role", "google_subject", "is_active", "last_login_at", "created_at", "updated_at" FROM `__old_users`;--> statement-breakpoint
DROP TABLE `__old_users`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_subject_unique` ON `users` (`google_subject`);
