-- The referral form becomes client configuration, so the server stops holding a
-- definition to validate answers against. `referrals.answers_json` stays — the
-- answers are still captured and still returned. What goes is
-- `referrals.form_definition_id`, which exists only to point at a definition
-- that will no longer be here, and the two form tables themselves.
--
-- Dropping that column means a full table rebuild: it is named in a FOREIGN KEY
-- constraint, so SQLite's ALTER TABLE ... DROP COLUMN refuses it.
--
-- ## Why this is hand-written, and why it is in this order
--
-- `drizzle-kit` generates this rebuild wrapped in `PRAGMA foreign_keys=OFF`.
-- That is a **silent no-op on D1**: SQLite ignores the pragma inside a
-- transaction and D1 runs statements in implicit ones. `PRAGMA
-- defer_foreign_keys=on` is D1's documented equivalent — violations are still
-- counted, just not checked until the transaction ends.
--
-- Deferring alone is not enough. SQLite tracks a *counter* of outstanding
-- violations: dropping `referrals` while `parcels` rows reference it increments
-- that counter once per child row, and only an insert **into the parent** brings
-- it back down. Copying the rows into `__new_referrals` before the drop never
-- touches the counter, so the generated ordering commits with the counter
-- positive and the whole migration rolls back with `FOREIGN KEY constraint
-- failed`. That was reproduced against a local D1 holding a referral, a parcel
-- and an edit key; it passes on an empty database, which is exactly what makes
-- it worth writing down.
--
-- Hence: park the rows in a plain table, rebuild, rename, and only then insert
-- them back — so the inserts land in the table `parcels` now points at and
-- settle the counter before commit.
--
-- One accepted loss: the implicit `DELETE FROM referrals` inside `DROP TABLE`
-- still performs foreign key *actions*, so `ON DELETE CASCADE` from
-- `referral_edit_keys` fires and those rows go. They are self-service keys with
-- a fifteen-minute life that are swept daily anyway, so the cost is that a
-- referrer who submitted moments before this ran must phone rather than edit.
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
CREATE TABLE `__old_referrals` AS SELECT "id", "session_id", "status", "referred_at", "cancelled_at", "cancelled_reason", "referrer_organisation", "authorised_referrer_id", "adults", "children", "is_delivery", "reason_id", "referrer_email", "referrer_phone", "referee_name", "referee_address", "referee_postcode", "referee_phone", "delivery_address", "answers_json", "pii_purged_at", "created_by_user_id", "created_at", "updated_at" FROM `referrals`;--> statement-breakpoint
CREATE TABLE `__new_referrals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`referred_at` text NOT NULL,
	`cancelled_at` text,
	`cancelled_reason` text,
	`referrer_organisation` text NOT NULL,
	`authorised_referrer_id` text,
	`adults` integer NOT NULL,
	`children` integer NOT NULL,
	`is_delivery` integer DEFAULT 0 NOT NULL,
	`reason_id` text NOT NULL,
	`referrer_email` text,
	`referrer_phone` text,
	`referee_name` text,
	`referee_address` text,
	`referee_postcode` text,
	`referee_phone` text,
	`delivery_address` text,
	`answers_json` text,
	`pii_purged_at` text,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`authorised_referrer_id`) REFERENCES `authorised_referrers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reason_id`) REFERENCES `referral_reasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "referrals_status_valid" CHECK("__new_referrals"."status" IN ('active', 'cancelled')),
	CONSTRAINT "referrals_adults_valid" CHECK("__new_referrals"."adults" >= 0),
	CONSTRAINT "referrals_children_valid" CHECK("__new_referrals"."children" >= 0),
	CONSTRAINT "referrals_household_not_empty" CHECK("__new_referrals"."adults" + "__new_referrals"."children" > 0),
	CONSTRAINT "referrals_is_delivery_boolean" CHECK("__new_referrals"."is_delivery" IN (0, 1))
);
--> statement-breakpoint
DROP TABLE `referrals`;--> statement-breakpoint
ALTER TABLE `__new_referrals` RENAME TO `referrals`;--> statement-breakpoint
INSERT INTO `referrals`("id", "session_id", "status", "referred_at", "cancelled_at", "cancelled_reason", "referrer_organisation", "authorised_referrer_id", "adults", "children", "is_delivery", "reason_id", "referrer_email", "referrer_phone", "referee_name", "referee_address", "referee_postcode", "referee_phone", "delivery_address", "answers_json", "pii_purged_at", "created_by_user_id", "created_at", "updated_at") SELECT "id", "session_id", "status", "referred_at", "cancelled_at", "cancelled_reason", "referrer_organisation", "authorised_referrer_id", "adults", "children", "is_delivery", "reason_id", "referrer_email", "referrer_phone", "referee_name", "referee_address", "referee_postcode", "referee_phone", "delivery_address", "answers_json", "pii_purged_at", "created_by_user_id", "created_at", "updated_at" FROM `__old_referrals`;--> statement-breakpoint
DROP TABLE `__old_referrals`;--> statement-breakpoint
CREATE INDEX `idx_referrals_session` ON `referrals` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_referrals_referred_at` ON `referrals` (`referred_at`);--> statement-breakpoint
-- Last, and in this order: `form_fields` references `form_definitions`, and
-- until the rebuild above landed, `referrals` referenced it too.
DROP TABLE `form_fields`;--> statement-breakpoint
DROP TABLE `form_definitions`;
