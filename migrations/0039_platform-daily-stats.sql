CREATE TABLE `platform_daily_stats` (
	`date` text PRIMARY KEY NOT NULL,
	`worker_requests_account_wide` integer NOT NULL,
	`worker_requests_this_app` integer NOT NULL,
	`worker_errors_this_app` integer NOT NULL,
	`worker_cpu_time_p99_us` integer NOT NULL,
	`worker_subrequests_sum` integer NOT NULL,
	`worker_wall_time_p99_ms` integer NOT NULL,
	`d1_rows_read` integer NOT NULL,
	`d1_rows_written` integer NOT NULL,
	`d1_storage_bytes` integer NOT NULL,
	`collected_at` text NOT NULL
);
