-- The pick-list-level `confirmed` status and the route that set it
-- (`POST /pick-lists/:id/confirm`) are unused by the client and are removed
-- entirely. Editing a pick list is now locked by the **session's** own
-- confirmation only — see `requireEditable` in `pick-lists.service.ts`. That
-- narrows `pick_lists_status_valid` to `('draft', 'printed')`, and SQLite has
-- no DROP CONSTRAINT, so this is a full table rebuild. `confirmed_by_user_id`
-- also carries a FOREIGN KEY, which SQLite refuses to drop in place even on
-- its own, so both go in the same rebuild as the CHECK change.
--
-- ## Why this is hand-written, and why it does more than 0008
--
-- `drizzle-kit`'s generated version of this rebuild wraps it in
-- `PRAGMA foreign_keys=OFF`, which is a **silent no-op on D1** (SQLite ignores
-- it inside a transaction and D1 runs statements in implicit ones), and it
-- copies `pick_lists` rows out before dropping the table — which is 0008's
-- first trap on its own. But `pick_lists` has a second, worse trap that
-- `referrals` and `users` did not: `parcels.pick_list_id` is
-- `ON DELETE CASCADE`, and `parcel_lines.parcel_id` cascades again from
-- `parcels`. `DROP TABLE pick_lists` performs an implicit delete of every
-- row, and **cascade actions fire regardless of `defer_foreign_keys`** — that
-- pragma defers violation *checks*, not cascade *actions* (0018 lost
-- `refresh_tokens` the same way). Left as drizzle-kit generated it, this
-- migration would silently delete every parcel and every parcel line ever
-- picked, on any database holding real pick-list data.
--
-- So this parks **three** tables, not one: `pick_lists` for the rebuild
-- itself, and `parcels` and `parcel_lines` because the drop-and-cascade wipes
-- them as a side effect. `pick_lists` is reinserted first so the cascade's
-- foreign key has a parent again, then `parcels`, then `parcel_lines`, each
-- insert settling the deferred-violation counter for the next table down. No
-- row in any of the three is lost, and no confirmation from Pete was needed to
-- discard anything, unlike 0012 — there is nothing here to discard.
--
-- The CHECK also names its column unqualified, unlike drizzle-kit's generated
-- `CHECK("__new_pick_lists"."status" ...)` — see 0022's header. D1's SQLite
-- rewrites that qualified form on `RENAME TO`; SQLite 3.51 does not, and fails
-- the rename with the old table already dropped and nothing to replace it.
-- `CHECK("status" ...)` means the same thing under both and sidesteps the
-- question entirely.
--
-- One more remap, not just a rebuild: the narrowed CHECK no longer allows
-- `'confirmed'`, and that value was reachable for as long as
-- `POST /pick-lists/:id/confirm` existed — whether or not the client ever
-- called it, the route was live and callable directly. Parking `status`
-- unchanged would carry a `'confirmed'` row straight into a CHECK that now
-- refuses it, failing the whole migration on the reinsert below. `'printed'`
-- is the correct landing value: a list could only reach `'confirmed'` after
-- being printed, and the lock that value stood for was replaced by the
-- session's own confirmation, which such a row already satisfies regardless.
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
CREATE TABLE `__old_pick_lists` AS SELECT "id", "session_id", CASE WHEN "status" = 'confirmed' THEN 'printed' ELSE "status" END AS "status", "generated_at", "generated_by_user_id", "first_printed_at", "created_at", "updated_at" FROM `pick_lists`;--> statement-breakpoint
CREATE TABLE `__old_parcels` AS SELECT * FROM `parcels`;--> statement-breakpoint
CREATE TABLE `__old_parcel_lines` AS SELECT * FROM `parcel_lines`;--> statement-breakpoint
CREATE TABLE `__new_pick_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`generated_at` text NOT NULL,
	`generated_by_user_id` text,
	`first_printed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`generated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pick_lists_status_valid" CHECK("status" IN ('draft', 'printed'))
);--> statement-breakpoint
DROP TABLE `pick_lists`;--> statement-breakpoint
ALTER TABLE `__new_pick_lists` RENAME TO `pick_lists`;--> statement-breakpoint
CREATE UNIQUE INDEX `pick_lists_session_id_unique` ON `pick_lists` (`session_id`);--> statement-breakpoint
INSERT INTO `pick_lists` ("id", "session_id", "status", "generated_at", "generated_by_user_id", "first_printed_at", "created_at", "updated_at") SELECT "id", "session_id", "status", "generated_at", "generated_by_user_id", "first_printed_at", "created_at", "updated_at" FROM `__old_pick_lists`;--> statement-breakpoint
DROP TABLE `__old_pick_lists`;--> statement-breakpoint
INSERT INTO `parcels` SELECT * FROM `__old_parcels`;--> statement-breakpoint
DROP TABLE `__old_parcels`;--> statement-breakpoint
INSERT INTO `parcel_lines` SELECT * FROM `__old_parcel_lines`;--> statement-breakpoint
DROP TABLE `__old_parcel_lines`;
