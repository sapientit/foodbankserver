-- `stock_ledger.movement_type` gains a third value, `correction` — a settled
-- decision, not a guess, see `INITIAL_SPEC1.txt`, "#Stock maintenance". A new
-- `CHECK` value means a full table rebuild: SQLite has no
-- `ALTER TABLE ... ADD CONSTRAINT`.
--
-- `stock_ledger` is not a foreign-key *parent* — nothing references
-- `stock_ledger.id` — so, as with `0032`'s `sms_messages`, this rebuild
-- carries none of `0008`/`0034`'s deferred-FK-counter complications and needs
-- no table parked alongside it. `PRAGMA defer_foreign_keys=on` replaces
-- drizzle-kit's generated `PRAGMA foreign_keys=OFF`, which is a silent no-op
-- on D1, the same swap every hand-fixed rebuild in this repo makes.
--
-- The `CHECK`s are deliberately unqualified (`CHECK("quantity_delta" ...)`,
-- not `CHECK("__new_stock_ledger"."quantity_delta" ...)`) for the reason
-- `0022`/`0026`/`0032`/`0034` all give: `ALTER TABLE ... RENAME TO` does not
-- reliably rewrite a qualified table name inside a `CHECK` on every SQLite
-- version, and a failed rewrite fails the rename after the old table has
-- already been dropped.
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
	CONSTRAINT "stock_ledger_delta_non_zero" CHECK("quantity_delta" <> 0),
	CONSTRAINT "stock_ledger_movement_type_valid" CHECK("movement_type" IN ('opening_balance', 'parcel_issued', 'correction'))
);
--> statement-breakpoint
INSERT INTO `__new_stock_ledger`("id", "stock_item_id", "quantity_delta", "movement_type", "parcel_id", "session_id", "actor_user_id", "occurred_at", "created_at") SELECT "id", "stock_item_id", "quantity_delta", "movement_type", "parcel_id", "session_id", "actor_user_id", "occurred_at", "created_at" FROM `stock_ledger`;--> statement-breakpoint
DROP TABLE `stock_ledger`;--> statement-breakpoint
ALTER TABLE `__new_stock_ledger` RENAME TO `stock_ledger`;--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_item` ON `stock_ledger` (`stock_item_id`);--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_session` ON `stock_ledger` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stock_ledger_parcel_movement` ON `stock_ledger` (`parcel_id`,`stock_item_id`,`movement_type`) WHERE "stock_ledger"."parcel_id" IS NOT NULL;
