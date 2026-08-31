CREATE TABLE `target_stock_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`lines_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `target_stock_lists_name_unique` ON `target_stock_lists` (`name`);