CREATE TABLE `referral_imports` (
	`import_key` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`reason_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reason_id`) REFERENCES `referral_reasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
