CREATE TABLE `parcel_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`parcel_id` text NOT NULL,
	`stock_item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`source` text DEFAULT 'model' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parcel_id`) REFERENCES `parcels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stock_item_id`) REFERENCES `stock_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "parcel_lines_quantity_positive" CHECK("parcel_lines"."quantity" > 0),
	CONSTRAINT "parcel_lines_source_valid" CHECK("parcel_lines"."source" IN ('model', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_parcel_lines_item` ON `parcel_lines` (`parcel_id`,`stock_item_id`);--> statement-breakpoint
CREATE TABLE `parcels` (
	`id` text PRIMARY KEY NOT NULL,
	`pick_list_id` text NOT NULL,
	`referral_id` text NOT NULL,
	`pick_number` integer NOT NULL,
	`adults` integer NOT NULL,
	`children` integer NOT NULL,
	`attendance` text DEFAULT 'pending' NOT NULL,
	`attendance_recorded_at` text,
	`attendance_recorded_by_user_id` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`pick_list_id`) REFERENCES `pick_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attendance_recorded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "parcels_attendance_valid" CHECK("parcels"."attendance" IN ('pending', 'attended', 'no_show', 'cancelled')),
	CONSTRAINT "parcels_adults_valid" CHECK("parcels"."adults" >= 0),
	CONSTRAINT "parcels_children_valid" CHECK("parcels"."children" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_parcels_referral_lookup` ON `parcels` (`referral_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_parcels_referral` ON `parcels` (`pick_list_id`,`referral_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_parcels_number` ON `parcels` (`pick_list_id`,`pick_number`);--> statement-breakpoint
CREATE TABLE `pick_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`generated_at` text NOT NULL,
	`generated_by_user_id` text,
	`first_printed_at` text,
	`confirmed_at` text,
	`confirmed_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`generated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pick_lists_status_valid" CHECK("pick_lists"."status" IN ('draft', 'printed', 'confirmed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pick_lists_session_id_unique` ON `pick_lists` (`session_id`);--> statement-breakpoint
CREATE TABLE `model_parcels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`contents_json` text NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_parcels_name_unique` ON `model_parcels` (`name`);--> statement-breakpoint
CREATE INDEX `idx_model_parcels_order` ON `model_parcels` (`display_order`);--> statement-breakpoint
CREATE TABLE `parcel_grid` (
	`id` text PRIMARY KEY NOT NULL,
	`grid_json` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "parcel_grid_singleton" CHECK("parcel_grid"."id" = 'current')
);
