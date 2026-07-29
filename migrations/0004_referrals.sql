CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`detail_json` text,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_events_actor_kind_valid" CHECK("audit_events"."actor_kind" IN ('user', 'referral_key', 'system', 'anonymous'))
);
--> statement-breakpoint
CREATE INDEX `idx_audit_entity` ON `audit_events` (`entity_type`,`entity_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `referral_edit_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`referral_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`use_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referral_edit_keys_key_hash_unique` ON `referral_edit_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `idx_referral_edit_keys_expires` ON `referral_edit_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `referrals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`form_definition_id` text NOT NULL,
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
	FOREIGN KEY (`form_definition_id`) REFERENCES `form_definitions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`authorised_referrer_id`) REFERENCES `authorised_referrers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reason_id`) REFERENCES `referral_reasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "referrals_status_valid" CHECK("referrals"."status" IN ('active', 'cancelled')),
	CONSTRAINT "referrals_adults_valid" CHECK("referrals"."adults" >= 0),
	CONSTRAINT "referrals_children_valid" CHECK("referrals"."children" >= 0),
	CONSTRAINT "referrals_household_not_empty" CHECK("referrals"."adults" + "referrals"."children" > 0),
	CONSTRAINT "referrals_is_delivery_boolean" CHECK("referrals"."is_delivery" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_referrals_session` ON `referrals` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_referrals_referred_at` ON `referrals` (`referred_at`);