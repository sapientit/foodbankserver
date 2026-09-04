-- `sms_messages.kind` gains a fifth value, `referrer_reply` — see the comment
-- on `SMS_MESSAGE_KINDS` in `src/db/schema/sms.ts` — and the table gains
-- `recipient_role`, both `CHECK`-constrained, so this is a full rebuild:
-- SQLite has no `ALTER TABLE ... ADD CONSTRAINT`.
--
-- Unlike `migrations/0008`/`0012`/etc, `sms_messages` is not a foreign-key
-- *parent* — nothing references `sms_messages.id` — so dropping and
-- recreating it carries none of those migrations' deferred-FK-counter
-- complications, and no other table needs parking alongside it.
-- `PRAGMA defer_foreign_keys=on` replaces drizzle-kit's generated
-- `PRAGMA foreign_keys=OFF`, which is a silent no-op on D1, the same swap
-- every hand-fixed rebuild in this repo makes.
--
-- `recipient_role` is a brand new column with nothing to backfill, so the
-- carried-forward `INSERT` selects a literal `NULL` for it rather than a
-- column of that name from the old table, which does not have one yet —
-- drizzle-kit's generated version gets this wrong and fails at migration
-- time with "no such column: recipient_role".
--
-- The `CHECK`s name their columns unqualified rather than
-- `"__new_sms_messages"."kind"` as drizzle-kit generates — see 0026's header:
-- D1's SQLite rewrites the qualified form on `RENAME TO`, but a newer SQLite
-- does not, and fails the rename with the old table already dropped.
--
-- `referrals.collection_method` rides in the same migration: a plain
-- `ALTER TABLE ... ADD COLUMN`, no rebuild needed because it carries no
-- `CHECK` — see the column's own comment in `src/db/schema/referrals.ts` for
-- why. The backfill reads every existing row's old `is_delivery` flag across
-- into the new column and can say nothing about `referrer_collect`, which
-- did not exist yet for any of them — `INITIAL_SPEC1.txt`, "#referral".
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
CREATE TABLE `__new_sms_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`referral_id` text,
	`session_id` text,
	`kind` text NOT NULL,
	`phone` text NOT NULL,
	`body` text NOT NULL,
	`provider_message_id` text,
	`occurred_at` text NOT NULL,
	`read_at` text,
	`sent_by_user_id` text,
	`recipient_role` text,
	`simulated` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sent_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sms_messages_kind_valid" CHECK("kind" IN ('reminder', 'staff_reply', 'household_reply', 'referrer_reply', 'failure')),
	CONSTRAINT "sms_messages_recipient_role_valid" CHECK("recipient_role" IS NULL OR "recipient_role" IN ('referee', 'referrer'))
);
--> statement-breakpoint
INSERT INTO `__new_sms_messages` ("id", "referral_id", "session_id", "kind", "phone", "body", "provider_message_id", "occurred_at", "read_at", "sent_by_user_id", "recipient_role", "simulated", "created_at", "updated_at") SELECT "id", "referral_id", "session_id", "kind", "phone", "body", "provider_message_id", "occurred_at", "read_at", "sent_by_user_id", NULL, "simulated", "created_at", "updated_at" FROM `sms_messages`;--> statement-breakpoint
DROP TABLE `sms_messages`;--> statement-breakpoint
ALTER TABLE `__new_sms_messages` RENAME TO `sms_messages`;--> statement-breakpoint
CREATE INDEX `idx_sms_messages_referral` ON `sms_messages` (`referral_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_sms_messages_occurred` ON `sms_messages` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_sms_messages_phone` ON `sms_messages` (`phone`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_sms_messages_session` ON `sms_messages` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sms_messages_provider` ON `sms_messages` (`provider_message_id`);--> statement-breakpoint
ALTER TABLE `referrals` ADD `collection_method` text;--> statement-breakpoint
UPDATE `referrals` SET `collection_method` = CASE WHEN `is_delivery` = 1 THEN 'delivery' ELSE 'collection' END;
