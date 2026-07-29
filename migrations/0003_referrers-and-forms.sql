CREATE TABLE `form_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_at` text,
	`retired_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "form_definitions_status_valid" CHECK("form_definitions"."status" IN ('draft', 'published', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `form_definitions_version_unique` ON `form_definitions` (`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_form_definitions_one_published` ON `form_definitions` (`status`) WHERE "form_definitions"."status" = 'published';--> statement-breakpoint
CREATE TABLE `form_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`form_definition_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`help_text` text,
	`type` text NOT NULL,
	`is_required` integer DEFAULT 0 NOT NULL,
	`options_json` text,
	`min_value` integer,
	`max_value` integer,
	`max_length` integer,
	`is_pii` integer DEFAULT 1 NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`form_definition_id`) REFERENCES `form_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "form_fields_type_valid" CHECK("form_fields"."type" IN ('text', 'textarea', 'number', 'boolean', 'select', 'multiselect', 'date')),
	CONSTRAINT "form_fields_is_required_boolean" CHECK("form_fields"."is_required" IN (0, 1)),
	CONSTRAINT "form_fields_is_pii_boolean" CHECK("form_fields"."is_pii" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_form_fields_definition` ON `form_fields` (`form_definition_id`,`display_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_form_fields_key` ON `form_fields` (`form_definition_id`,`key`);--> statement-breakpoint
CREATE TABLE `authorised_referrers` (
	`id` text PRIMARY KEY NOT NULL,
	`match_type` text NOT NULL,
	`match_value` text NOT NULL,
	`organisation_name` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "authorised_referrers_match_type_valid" CHECK("authorised_referrers"."match_type" IN ('email', 'domain')),
	CONSTRAINT "authorised_referrers_is_active_boolean" CHECK("authorised_referrers"."is_active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_authorised_referrers_match` ON `authorised_referrers` (`match_type`,`match_value`);--> statement-breakpoint
CREATE TABLE `referral_reasons` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "referral_reasons_is_active_boolean" CHECK("referral_reasons"."is_active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referral_reasons_code_unique` ON `referral_reasons` (`code`);