-- A parcel line loses `source`, and its quantity gains one non-quantity.
--
-- ## `source` is gone
--
-- It held 'model' or 'manual' and nothing ever read it: no query filtered on
-- it, no rule branched on it, and `INITIAL_SPEC1.txt` never asks for the
-- distinction. It only travelled to the client, including onto printed sheets.
--
-- What is deliberately lost: after this, nothing in the data explains why a
-- parcel differs from what the grid says its household should get. That was the
-- column's stated purpose and it is a real loss, accepted because the charity
-- never asked for the answer and nothing computed it.
--
-- ## The quantity CHECK widens to admit -1
--
-- -1 on a line means "a team leader must decide this item" — the household
-- asked for something the client's preference rules could not turn into a
-- number. It is not a quantity and never behaves like one: a parcel holding one
-- cannot be reviewed, and since printing and attendance both wait for review,
-- it can reach neither a sheet nor the stock ledger.
--
-- `parcel_lines_quantity_positive` is therefore renamed
-- `parcel_lines_quantity_valid`: the old name would be a lie about a column
-- that now admits a negative. Zero is still not a line — removing an item
-- deletes the row.
--
-- **This half rests on an assumed answer to Q28** (item-level rather than
-- answer-level attention). See `OPEN-QUESTIONS.md` and the `x-assumed` entries
-- in `openapi.yaml`. If the charity chooses answer-level attention instead, the
-- CHECK narrows back to `> 0` in a further rebuild.
--
-- ## Why a rebuild, and why not 0008's dance
--
-- `source` is named in the CHECK `parcel_lines_source_valid`, and SQLite
-- refuses DROP COLUMN for a column in a CHECK. There is no DROP CONSTRAINT
-- either, so both changes need the table rebuilt whatever order they arrive in.
--
-- 0008 had to park rows in a temporary table because it rebuilt `referrals`,
-- which `parcels` references: dropping a *parent* increments SQLite's
-- outstanding-violation counter once per child row, and only an insert back
-- into the parent brings it down.
--
-- `parcel_lines` is nobody's parent. Nothing has a foreign key to it, so the
-- drop increments nothing and a plain create-copy-drop-rename is correct — the
-- same case as 0015. `defer_foreign_keys` is still set, because the rows being
-- copied reference `parcels` and `stock_items` and the copy is not atomic with
-- respect to those constraints.
--
-- `PRAGMA foreign_keys=OFF` is what drizzle-kit generates here and it is a
-- silent no-op on D1. See `docs/engineering/d1-constraints.md`.
--
-- ## The CHECK names its column unqualified, unlike 0008/0015/0018
--
-- Those write `CHECK("__new_x"."col" ...)`, which is what drizzle-kit emits.
-- D1's SQLite accepts it and rewrites the reference on RENAME, which is why
-- they work and why the test suite applies them clean. **SQLite 3.51 does
-- not**: the rename fails with `error in table x after rename: no such column:
-- __new_x.col`. Reproduce it with `sqlite3` on any recent machine against 0015.
--
-- Nothing is wrong with those migrations — a database that has already applied
-- one never applies it again. But production is still at 0006 and will run this
-- one forward, possibly on a newer D1 than the one under test. An unqualified
-- column name means the same thing to every version, so this migration uses it
-- and does not depend on the rewrite happening.
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
CREATE TABLE `__new_parcel_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`parcel_id` text NOT NULL,
	`stock_item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parcel_id`) REFERENCES `parcels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stock_item_id`) REFERENCES `stock_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "parcel_lines_quantity_valid" CHECK("quantity" > 0 OR "quantity" = -1)
);--> statement-breakpoint
INSERT INTO `__new_parcel_lines` ("id", "parcel_id", "stock_item_id", "quantity", "created_at", "updated_at")
	SELECT "id", "parcel_id", "stock_item_id", "quantity", "created_at", "updated_at"
	FROM `parcel_lines`;--> statement-breakpoint
DROP TABLE `parcel_lines`;--> statement-breakpoint
ALTER TABLE `__new_parcel_lines` RENAME TO `parcel_lines`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_parcel_lines_item` ON `parcel_lines` (`parcel_id`,`stock_item_id`);
