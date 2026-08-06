-- Text reminders, the replies to them, and the two session fields the reminders
-- need. See `INITIAL_SPEC1.txt`, "SMS reminders and replies" and "Session
-- maintenance".
--
-- ## Nothing here is a rebuild, and that is the point
--
-- `sms_messages` is a new table that nothing references, so it is a plain
-- CREATE. The four session columns are `ALTER TABLE ... ADD COLUMN`, which
-- SQLite allows: it refuses ADD COLUMN only for a PRIMARY KEY or UNIQUE
-- constraint, or a NOT NULL column without a non-null default — and
-- `deliveries_allowed` has one.
--
-- **`drizzle-kit` will not generate this file.** Given the same schema change
-- it proposes rebuilding `sessions` and `recurring_sessions`, which are the
-- foreign-key parents of `referrals`, `pick_lists` and each other. Read the
-- header of `0008` before entertaining that: dropping a parent leaves SQLite's
-- deferred-violation counter positive and the whole migration rolls back, and
-- the dance that works costs four extra statements per table. There is nothing
-- here worth paying it for.
--
-- ## Why `deliveries_allowed` has no CHECK
--
-- Every other boolean in this database is `CHECK (x IN (0, 1))`. This one is
-- not, because a CHECK is a *table* constraint and SQLite cannot add one to an
-- existing table — having it would mean the rebuild described above, on two
-- parent tables, to gain a constraint that `sessions.schema.ts` already
-- enforces with `z.boolean()` at the only point a value can enter.
--
-- The Drizzle schema deliberately omits the `check()` too, so this file and
-- `src/db/schema/sessions.ts` describe the same table and the next
-- `db:generate` does not see a difference to correct. If either table is ever
-- rebuilt for another reason, add the constraint in that rebuild.
--
-- ## `sms_messages.provider_message_id`
--
-- The unique index on it is the webhook's idempotency guard, not tidiness.
-- TheSMSWorks retries any webhook it did not get a 200 for, so the same reply
-- arrives more than once; the index turns the second one into a caught unique
-- violation instead of a duplicate on a volunteer's screen. NULLs are distinct
-- in SQLite, so failure rows with no provider id do not collide.
ALTER TABLE `recurring_sessions` ADD COLUMN `delivery_time` text;--> statement-breakpoint
ALTER TABLE `recurring_sessions` ADD COLUMN `deliveries_allowed` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `delivery_time` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `deliveries_allowed` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE TABLE `sms_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`referral_id` text,
	`kind` text NOT NULL,
	`phone` text NOT NULL,
	`body` text NOT NULL,
	`provider_message_id` text,
	`occurred_at` text NOT NULL,
	`read_at` text,
	`sent_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sent_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sms_messages_kind_valid" CHECK("sms_messages"."kind" IN ('reminder', 'staff_reply', 'household_reply', 'failure'))
);
--> statement-breakpoint
CREATE INDEX `idx_sms_messages_referral` ON `sms_messages` (`referral_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_sms_messages_occurred` ON `sms_messages` (`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sms_messages_provider` ON `sms_messages` (`provider_message_id`);
