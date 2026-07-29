CREATE TABLE `recurring_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`weekday` integer NOT NULL,
	`start_time` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`location` text NOT NULL,
	`capacity` integer DEFAULT 25 NOT NULL,
	`active_from` text NOT NULL,
	`active_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "recurring_sessions_weekday_valid" CHECK("recurring_sessions"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "recurring_sessions_duration_positive" CHECK("recurring_sessions"."duration_minutes" > 0),
	CONSTRAINT "recurring_sessions_capacity_valid" CHECK("recurring_sessions"."capacity" >= 0)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`recurring_session_id` text,
	`occurrence_date` text,
	`session_date` text NOT NULL,
	`start_time` text NOT NULL,
	`starts_at_utc` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`location` text NOT NULL,
	`capacity` integer NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`cancelled_reason` text,
	`is_customised` integer DEFAULT 0 NOT NULL,
	`generated_at` text,
	`confirmed_at` text,
	`confirmed_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`recurring_session_id`) REFERENCES `recurring_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sessions_status_valid" CHECK("sessions"."status" IN ('planned', 'in_progress', 'confirmed', 'cancelled')),
	CONSTRAINT "sessions_duration_positive" CHECK("sessions"."duration_minutes" > 0),
	CONSTRAINT "sessions_capacity_valid" CHECK("sessions"."capacity" >= 0),
	CONSTRAINT "sessions_is_customised_boolean" CHECK("sessions"."is_customised" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_starts_at` ON `sessions` (`starts_at_utc`);--> statement-breakpoint
CREATE INDEX `idx_sessions_status_date` ON `sessions` (`status`,`session_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sessions_occurrence` ON `sessions` (`recurring_session_id`,`occurrence_date`);