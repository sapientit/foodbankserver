-- Stock moves six ways: an opening balance, a shop, a donation, a parcel given
-- to a client, wastage, and a hand correction. `expiry`, `parcel_returned` and
-- `stock_take_adjustment` leave the vocabulary.
--
-- D1 has no `DROP CONSTRAINT`, so narrowing a `CHECK` means rebuilding the
-- table. `stock_ledger` is append-only and holds the entire stock history, so
-- **every row has to survive**, and the three partial unique indexes on it are
-- the idempotency guards — a retried attendance, a double-tapped shop and a
-- re-committed stock take are all stopped by an index and nothing else. They are
-- recreated below with their `WHERE` clauses intact; drop a clause and the
-- double-tap protection disappears without a single test failing, because a
-- non-partial index over nullable columns still admits every row it needs to.
--
-- ## Retired values on existing rows
--
-- A row holding a retired value would violate the new `CHECK` and roll the whole
-- migration back, so the copy-back rewrites them. This is not the application
-- editing history — the rebuild rewrites every row anyway — it is the retired
-- vocabulary being restated in the surviving one:
--
--   * `stock_take_adjustment` → `correction`. A stock take's variance is a
--     correction, and that is what the service now writes for it. Those rows
--     still carry a non-null `stock_take_id`, so nothing about their origin is
--     lost even though the movement type no longer says it. Whether the charity
--     wants the two told apart in a report is **Q13** and only Pete can settle
--     it; until then this is a marked assumption, not a decision.
--   * `parcel_returned` → `correction`. Nothing ever wrote one: the reversal
--     path went when attendance became final, and `test/attendance.test.ts`
--     asserts no parcel ever grows a second movement. Rewritten defensively so a
--     database that somehow holds one still migrates.
--   * `expiry` → `wastage`, with the original word kept on the front of the
--     reason so the row still says what it was. Food past its date is food
--     thrown away; folding it in is the only mapping among the six that does not
--     invent a meaning.
--
-- None of the rewrites can collide with a guard: `stock_take_adjustment` was the
-- only type ever written against a `stock_take_id`, so a uniform rename keeps
-- `(stock_take_id, stock_item_id, movement_type)` unique, and `parcel_returned`
-- moving to `correction` stays distinct from the `parcel_issued` row beside it.
--
-- ## Ordering
--
-- `stock_ledger` is a child of `stock_items`, `sessions`, `purchases`,
-- `stock_takes` and `users`, and a parent of nothing, so dropping it raises no
-- deferred foreign-key counter — the trap 0008 documents does not apply here.
-- The pragma and the park-drop-rename-insert shape are kept anyway so the rows
-- are safely out of the way before the drop, and so the inserts are checked
-- against the parents they will actually live under.
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
CREATE TABLE `__old_stock_ledger` AS SELECT "id", "stock_item_id", "quantity_delta", "movement_type", "parcel_id", "session_id", "purchase_id", "stock_take_id", "reason", "actor_user_id", "occurred_at", "created_at" FROM `stock_ledger`;--> statement-breakpoint
CREATE TABLE `__new_stock_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`stock_item_id` text NOT NULL,
	`quantity_delta` integer NOT NULL,
	`movement_type` text NOT NULL,
	`parcel_id` text,
	`session_id` text,
	`purchase_id` text,
	`stock_take_id` text,
	`reason` text,
	`actor_user_id` text,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`stock_item_id`) REFERENCES `stock_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stock_take_id`) REFERENCES `stock_takes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_ledger_delta_non_zero" CHECK("__new_stock_ledger"."quantity_delta" <> 0),
	CONSTRAINT "stock_ledger_movement_type_valid" CHECK("__new_stock_ledger"."movement_type" IN ('opening_balance', 'purchase', 'donation', 'parcel_issued', 'wastage', 'correction'))
);
--> statement-breakpoint
DROP TABLE `stock_ledger`;--> statement-breakpoint
ALTER TABLE `__new_stock_ledger` RENAME TO `stock_ledger`;--> statement-breakpoint
INSERT INTO `stock_ledger`("id", "stock_item_id", "quantity_delta", "movement_type", "parcel_id", "session_id", "purchase_id", "stock_take_id", "reason", "actor_user_id", "occurred_at", "created_at") SELECT "id", "stock_item_id", "quantity_delta", CASE "movement_type" WHEN 'stock_take_adjustment' THEN 'correction' WHEN 'parcel_returned' THEN 'correction' WHEN 'expiry' THEN 'wastage' ELSE "movement_type" END, "parcel_id", "session_id", "purchase_id", "stock_take_id", CASE WHEN "movement_type" = 'expiry' THEN 'Recorded as expiry: ' || COALESCE("reason", '') ELSE "reason" END, "actor_user_id", "occurred_at", "created_at" FROM `__old_stock_ledger`;--> statement-breakpoint
DROP TABLE `__old_stock_ledger`;--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_item` ON `stock_ledger` (`stock_item_id`);--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_session` ON `stock_ledger` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stock_ledger_parcel_movement` ON `stock_ledger` (`parcel_id`,`stock_item_id`,`movement_type`) WHERE "stock_ledger"."parcel_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stock_ledger_purchase_movement` ON `stock_ledger` (`purchase_id`,`stock_item_id`,`movement_type`) WHERE "stock_ledger"."purchase_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stock_ledger_stock_take_movement` ON `stock_ledger` (`stock_take_id`,`stock_item_id`,`movement_type`) WHERE "stock_ledger"."stock_take_id" IS NOT NULL;
