-- Referrals change shape for the real referral form.
--
-- A referrer whose address is not on the authorised list is no longer refused:
-- the referral is taken as `pending_review` and an administrator accepts or
-- rejects it. That adds two statuses, so `referrals_status_valid` changes — and
-- SQLite has no DROP CONSTRAINT, so this is a full table rebuild whatever else
-- it carries. The rest rides along in the same rebuild rather than paying for a
-- second one:
--
--   review_comment, reviewed_by_user_id  the administrator's one-line note and
--                                        who wrote it
--   needs_fuel_help                      a key question that is reported on, so
--                                        a column rather than a dynamic answer
--   referrer_name                        the referrer names themselves now that
--                                        an unknown one may still submit
--   referee_first_name, referee_surname  the surname is what a list sorts by and
--                                        what a volunteer matches a bag to
--   referee_date_of_birth                a date, not an age; an age is wrong a
--                                        year later
--
-- `referee_name` is still here — it goes in 0013, on its own, because
-- drizzle-kit cannot tell a drop-plus-adds from a rename without being asked.
--
-- `referral_edit_keys` goes entirely. The fifteen-minute self-service window is
-- withdrawn: a referrer confirms what they sent and phones the food bank if it
-- needs changing. Dropping it first also takes away the ON DELETE CASCADE that
-- 0008 had to accept as a loss, so the rebuild below has one less child to
-- reason about.
--
-- ## Why this is hand-written and does not preserve rows
--
-- Confirmed with Pete on 2026-08-05: there is no data worth keeping in any of
-- these tables, so this clears the children and recreates the parent rather than
-- performing 0008's park-rebuild-rename-reinsert dance. Read 0008 before
-- reaching for that dance again — and do not trust what drizzle-kit generates
-- here. Its version of this file wraps the rebuild in `PRAGMA foreign_keys=OFF`,
-- which is a **silent no-op on D1** (SQLite ignores it inside a transaction, and
-- D1 runs statements in implicit ones), and it copies rows out before dropping
-- the parent, which leaves the deferred foreign-key counter positive at commit.
--
-- Emptying `parcels` first is what keeps that counter at zero: `DROP TABLE
-- referrals` performs an implicit delete that still fires foreign-key actions,
-- and only an insert **into the parent** brings the counter back down.
--
-- One accepted consequence: `stock_ledger.parcel_id` deliberately has no foreign
-- key, so ledger rows written against the deleted parcels are left orphaned. The
-- ledger is append-only and must not be rewritten to tidy them. They are
-- harmless only because none of this data is real.
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
DROP TABLE `referral_edit_keys`;--> statement-breakpoint
DELETE FROM `parcel_lines`;--> statement-breakpoint
DELETE FROM `parcels`;--> statement-breakpoint
DROP TABLE `referrals`;--> statement-breakpoint
CREATE TABLE `referrals` (
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
	`referee_name` text,
	`referee_first_name` text,
	`referee_surname` text,
	`referee_date_of_birth` text,
	`referee_address` text,
	`referee_postcode` text,
	`referee_phone` text,
	`answers_json` text,
	`pii_purged_at` text,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`authorised_referrer_id`) REFERENCES `authorised_referrers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reason_id`) REFERENCES `referral_reasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "referrals_status_valid" CHECK("referrals"."status" IN ('pending_review', 'active', 'rejected', 'cancelled')),
	CONSTRAINT "referrals_adults_valid" CHECK("referrals"."adults" >= 0),
	CONSTRAINT "referrals_children_valid" CHECK("referrals"."children" >= 0),
	CONSTRAINT "referrals_household_not_empty" CHECK("referrals"."adults" + "referrals"."children" > 0),
	CONSTRAINT "referrals_is_delivery_boolean" CHECK("referrals"."is_delivery" IN (0, 1)),
	CONSTRAINT "referrals_needs_fuel_help_boolean" CHECK("referrals"."needs_fuel_help" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_referrals_session` ON `referrals` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_referrals_referred_at` ON `referrals` (`referred_at`);
