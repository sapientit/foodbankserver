CREATE TABLE `purchase_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`stock_item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stock_item_id`) REFERENCES `stock_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_lines_quantity_positive" CHECK("purchase_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_purchase_lines_item` ON `purchase_lines` (`purchase_id`,`stock_item_id`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`purchased_at` text NOT NULL,
	`note` text,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stock_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_normalised` text NOT NULL,
	`unit` text NOT NULL,
	`shelf_number` text NOT NULL,
	`shelf_sort_key` text NOT NULL,
	`low_stock_threshold` integer,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "stock_items_is_active_boolean" CHECK("stock_items"."is_active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_items_name_normalised_unique` ON `stock_items` (`name_normalised`);--> statement-breakpoint
CREATE INDEX `idx_stock_items_shelf` ON `stock_items` (`shelf_sort_key`);--> statement-breakpoint
CREATE INDEX `idx_stock_items_name` ON `stock_items` (`name_normalised`);--> statement-breakpoint
CREATE TABLE `stock_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`stock_item_id` text NOT NULL,
	`quantity_delta` integer NOT NULL,
	`movement_type` text NOT NULL,
	`parcel_id` text,
	`session_id` text,
	`purchase_id` text,
	`stock_take_id` text,
	`reason` text,
	`actor_user_id` text,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`stock_item_id`) REFERENCES `stock_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stock_take_id`) REFERENCES `stock_takes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_ledger_delta_non_zero" CHECK("stock_ledger"."quantity_delta" <> 0),
	CONSTRAINT "stock_ledger_movement_type_valid" CHECK("stock_ledger"."movement_type" IN ('opening_balance', 'purchase', 'donation', 'parcel_issued', 'parcel_returned', 'stock_take_adjustment', 'wastage', 'expiry', 'correction'))
);
--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_item` ON `stock_ledger` (`stock_item_id`);--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_session` ON `stock_ledger` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stock_ledger_parcel_movement` ON `stock_ledger` (`parcel_id`,`stock_item_id`,`movement_type`) WHERE "stock_ledger"."parcel_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stock_ledger_purchase_movement` ON `stock_ledger` (`purchase_id`,`stock_item_id`,`movement_type`) WHERE "stock_ledger"."purchase_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stock_ledger_stock_take_movement` ON `stock_ledger` (`stock_take_id`,`stock_item_id`,`movement_type`) WHERE "stock_ledger"."stock_take_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `stock_take_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`stock_take_id` text NOT NULL,
	`stock_item_id` text NOT NULL,
	`counted_quantity` integer NOT NULL,
	`expected_quantity` integer,
	FOREIGN KEY (`stock_take_id`) REFERENCES `stock_takes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stock_item_id`) REFERENCES `stock_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_take_lines_counted_valid" CHECK("stock_take_lines"."counted_quantity" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stock_take_lines_item` ON `stock_take_lines` (`stock_take_id`,`stock_item_id`);--> statement-breakpoint
CREATE TABLE `stock_takes` (
	`id` text PRIMARY KEY NOT NULL,
	`counted_at` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text,
	`created_by_user_id` text NOT NULL,
	`committed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_takes_status_valid" CHECK("stock_takes"."status" IN ('open', 'committed', 'abandoned'))
);
