-- The stock simplification: the weekly count becomes the single source of truth.
--
-- Shopping, donations, wastage and hand corrections are gone as concepts, so
-- `purchases`, `purchase_lines`, `stock_takes` and `stock_take_lines` go with
-- them, and `stock_ledger` narrows to the two movements that remain — a count
-- setting an opening balance, and a parcel going to a household.
--
-- ## Why the ledger is rebuilt rather than altered
--
-- Two of the three changes to it need a rebuild on their own. `movement_type`
-- is a CHECK constraint and SQLite has no DROP CONSTRAINT, and `purchase_id`
-- and `stock_take_id` are both named in unique indexes and in FOREIGN KEY
-- clauses pointing at tables this migration deletes. `reason` could have been
-- dropped in place; it goes in the same rebuild because it existed only to
-- explain a hand correction and there are no longer any.
--
-- ## Why the deferred-foreign-key dance in 0008 is not needed here
--
-- 0008 had to park rows in a temporary table because it rebuilt `referrals`,
-- which `parcels` references: dropping a *parent* increments SQLite's
-- outstanding-violation counter once per child row, and only an insert back
-- into the parent brings it down.
--
-- `stock_ledger` is nobody's parent. Nothing has a foreign key to it, so the
-- drop increments nothing and a plain create-copy-drop-rename is correct. The
-- four dropped tables are parents, which is why their children go first: with
-- `purchase_lines` already gone, dropping `purchases` leaves no dangling
-- reference to count. `defer_foreign_keys` is still set, because the ledger
-- rows being copied reference `stock_items`, `sessions` and `users`, and the
-- copy is not atomic with respect to those constraints inside one statement.
--
-- ## What is deliberately lost
--
-- Rows whose `movement_type` is one of the four being removed are **not**
-- copied. They are shopping, donations, wastage and corrections, and there is
-- no longer any such thing — carrying them over would leave levels reflecting
-- movements the system can no longer explain, name or reproduce. The next stock
-- take restates every level from physical stock, which is the whole point of
-- the change and the reason this is safe to do.
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
CREATE TABLE `__new_stock_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`stock_item_id` text NOT NULL,
	`quantity_delta` integer NOT NULL,
	`movement_type` text NOT NULL,
	`parcel_id` text,
	`session_id` text,
	`actor_user_id` text,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`stock_item_id`) REFERENCES `stock_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_ledger_delta_non_zero" CHECK("__new_stock_ledger"."quantity_delta" <> 0),
	CONSTRAINT "stock_ledger_movement_type_valid" CHECK("__new_stock_ledger"."movement_type" IN ('opening_balance', 'parcel_issued'))
);--> statement-breakpoint
INSERT INTO `__new_stock_ledger` ("id", "stock_item_id", "quantity_delta", "movement_type", "parcel_id", "session_id", "actor_user_id", "occurred_at", "created_at")
	SELECT "id", "stock_item_id", "quantity_delta", "movement_type", "parcel_id", "session_id", "actor_user_id", "occurred_at", "created_at"
	FROM `stock_ledger`
	WHERE "movement_type" IN ('opening_balance', 'parcel_issued');--> statement-breakpoint
DROP TABLE `stock_ledger`;--> statement-breakpoint
ALTER TABLE `__new_stock_ledger` RENAME TO `stock_ledger`;--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_item` ON `stock_ledger` (`stock_item_id`);--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_session` ON `stock_ledger` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stock_ledger_parcel_movement` ON `stock_ledger` (`parcel_id`,`stock_item_id`,`movement_type`) WHERE "stock_ledger"."parcel_id" IS NOT NULL;--> statement-breakpoint
DROP TABLE `purchase_lines`;--> statement-breakpoint
DROP TABLE `purchases`;--> statement-breakpoint
DROP TABLE `stock_take_lines`;--> statement-breakpoint
DROP TABLE `stock_takes`;
