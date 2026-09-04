-- `INITIAL_SPEC1.txt`, `#Christmas voucher and first-time selection`.
--
-- `voucher_config` is a brand new table with nothing referencing it, so
-- unlike `referrals` it can carry real `CHECK`s: the singleton id, the same
-- pattern `parcel_grid` uses, and `end_date >= start_date`.
--
-- `referrals.first_time_review_status` carries no `CHECK`, the same
-- deliberate omission `collection_method` made in migration `0032`:
-- `referrals` is a foreign-key parent (`parcels`, `sms_messages`), so adding
-- one here would force the drop-and-recreate rebuild `migrations/0008`
-- exists to explain. Validity is enforced in `referrals.schema.ts` instead.
--
-- The column's own `DEFAULT 'unreviewed'` is what a referral created from
-- here on gets. The `UPDATE` below is a one-off backfill layered on top of
-- that default, not a repeat of it: every referral that already exists is
-- swept straight to `no_previous_referral` rather than landing every
-- household the food bank has ever fed in one administrator's unreviewed
-- queue.
CREATE TABLE `voucher_config` (
	`id` text PRIMARY KEY NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "voucher_config_singleton" CHECK("voucher_config"."id" = 'current'),
	CONSTRAINT "voucher_config_date_order" CHECK("voucher_config"."end_date" >= "voucher_config"."start_date")
);
--> statement-breakpoint
ALTER TABLE `referrals` ADD `first_time_review_status` text DEFAULT 'unreviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE `referrals` ADD `first_time_review_date` text;--> statement-breakpoint
UPDATE `referrals` SET `first_time_review_status` = 'no_previous_referral';
