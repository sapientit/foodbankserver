CREATE TABLE `system_jobs` (
	`name` text PRIMARY KEY NOT NULL,
	`last_run_at` text,
	`last_success_at` text,
	`last_error` text,
	`run_count` integer DEFAULT 0 NOT NULL
);
