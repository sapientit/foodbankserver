ALTER TABLE `platform_daily_stats` ADD `r2_storage_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_daily_stats` ADD `r2_class_a_operations` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_daily_stats` ADD `r2_class_b_operations` integer DEFAULT 0 NOT NULL;