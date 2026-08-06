-- Every referral is meant to be read by an administrator, and a referral now
-- says whether that has happened: `pending_review → active → reviewed`, with
-- `rejected` off the first step and `cancelled` reachable from any of them.
--
-- The charity chose a step on the existing pipeline over a separate flag,
-- knowing what it costs: a referral cancelled after being read reads as
-- `cancelled` and no longer records that anybody read it. See
-- `INITIAL_SPEC1.txt`, "Reviewing a referral".
--
-- `status` is a CHECK constraint and SQLite has no DROP CONSTRAINT, so adding
-- one value is a full table rebuild.
--
-- `sms_reminder_sent_at` rides along in it. Reminding a household by text was
-- settled but not yet built when this was written; `0017` and `modules/sms`
-- are what made use of the column. Adding it here cost nothing on top of a
-- rebuild that was happening
-- anyway, where adding it later would cost a second one — the same reasoning
-- 0012 used to carry five changes in one rebuild. It could have been an
-- `ALTER TABLE ADD COLUMN` on its own; that is the cheap half of the argument,
-- and the expensive half is that this table's next rebuild is not scheduled.
--
-- ## Why this preserves rows, unlike 0012
--
-- 0012 emptied `parcels` and recreated `referrals` because Pete confirmed no
-- table held data worth keeping. That is not a licence to keep doing it: this
-- one follows **0008**, which is the shape to copy once a database holds
-- anything real. Read 0008's header before touching either.
--
-- The dance exists because `parcels` has a foreign key to `referrals`.
-- Dropping a *parent* increments SQLite's outstanding-violation counter once
-- per child row, and **only an insert back into the parent** brings it down —
-- so copying rows into a new table before the drop leaves the counter positive
-- at commit and the whole migration rolls back with `FOREIGN KEY constraint
-- failed`. Hence: park the rows in a plain table, rebuild, rename, and only
-- then insert them back, so the inserts land in the table `parcels` points at.
--
-- `PRAGMA defer_foreign_keys=on` rather than `foreign_keys=OFF`: the latter is
-- a silent no-op on D1, which runs statements in implicit transactions.
--
-- No `ON DELETE CASCADE` reaches `referrals` any more — `referral_edit_keys`
-- went in 0012 — so the implicit delete inside `DROP TABLE` takes nothing with
-- it. `parcels.referral_id` is `ON DELETE no action`, which is why the counter
-- is the only thing to manage.
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
CREATE TABLE `__old_referrals` AS SELECT "id", "session_id", "status", "referred_at", "cancelled_at", "cancelled_reason", "review_comment", "reviewed_by_user_id", "referrer_organisation", "authorised_referrer_id", "adults", "children", "is_delivery", "reason_id", "needs_fuel_help", "referrer_name", "referrer_email", "referrer_phone", "referee_first_name", "referee_surname", "referee_date_of_birth", "referee_address", "referee_postcode", "referee_phone", "answers_json", "pii_purged_at", "created_by_user_id", "created_at", "updated_at" FROM `referrals`;--> statement-breakpoint
CREATE TABLE `__new_referrals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`referred_at` text NOT NULL,
	`cancelled_at` text,
	`cancelled_reason` text,
	`review_comment` text,
	`reviewed_by_user_id` text,
	`referrer_organisation` text NOT NULL,
	`authorised_referrer_id` text,
	`adults` integer NOT NULL,
	`children` integer NOT NULL,
	`is_delivery` integer DEFAULT 0 NOT NULL,
	`reason_id` text NOT NULL,
	`needs_fuel_help` integer DEFAULT 0 NOT NULL,
	`referrer_name` text,
	`referrer_email` text,
	`referrer_phone` text,
	`referee_first_name` text,
	`referee_surname` text,
	`referee_date_of_birth` text,
	`referee_address` text,
	`referee_postcode` text,
	`referee_phone` text,
	`answers_json` text,
	`sms_reminder_sent_at` text,
	`pii_purged_at` text,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`authorised_referrer_id`) REFERENCES `authorised_referrers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reason_id`) REFERENCES `referral_reasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "referrals_status_valid" CHECK("__new_referrals"."status" IN ('pending_review', 'active', 'reviewed', 'rejected', 'cancelled')),
	CONSTRAINT "referrals_adults_valid" CHECK("__new_referrals"."adults" >= 0),
	CONSTRAINT "referrals_children_valid" CHECK("__new_referrals"."children" >= 0),
	CONSTRAINT "referrals_household_not_empty" CHECK("__new_referrals"."adults" + "__new_referrals"."children" > 0),
	CONSTRAINT "referrals_is_delivery_boolean" CHECK("__new_referrals"."is_delivery" IN (0, 1)),
	CONSTRAINT "referrals_needs_fuel_help_boolean" CHECK("__new_referrals"."needs_fuel_help" IN (0, 1))
);
--> statement-breakpoint
DROP TABLE `referrals`;--> statement-breakpoint
ALTER TABLE `__new_referrals` RENAME TO `referrals`;--> statement-breakpoint
INSERT INTO `referrals`("id", "session_id", "status", "referred_at", "cancelled_at", "cancelled_reason", "review_comment", "reviewed_by_user_id", "referrer_organisation", "authorised_referrer_id", "adults", "children", "is_delivery", "reason_id", "needs_fuel_help", "referrer_name", "referrer_email", "referrer_phone", "referee_first_name", "referee_surname", "referee_date_of_birth", "referee_address", "referee_postcode", "referee_phone", "answers_json", "pii_purged_at", "created_by_user_id", "created_at", "updated_at") SELECT "id", "session_id", "status", "referred_at", "cancelled_at", "cancelled_reason", "review_comment", "reviewed_by_user_id", "referrer_organisation", "authorised_referrer_id", "adults", "children", "is_delivery", "reason_id", "needs_fuel_help", "referrer_name", "referrer_email", "referrer_phone", "referee_first_name", "referee_surname", "referee_date_of_birth", "referee_address", "referee_postcode", "referee_phone", "answers_json", "pii_purged_at", "created_by_user_id", "created_at", "updated_at" FROM `__old_referrals`;--> statement-breakpoint
DROP TABLE `__old_referrals`;--> statement-breakpoint
CREATE INDEX `idx_referrals_session` ON `referrals` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_referrals_referred_at` ON `referrals` (`referred_at`);
