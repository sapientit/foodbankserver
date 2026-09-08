-- Stock-take groupings, crates, and packing-unit fields on stock items.
--
-- `stock_take_groupings` and the seed row come first, and are unremarkable. The
-- interesting part is `stock_items`, which gains a `grouping_id` foreign key
-- alongside two plain columns — and gaining a new CHECK constraint
-- (`stock_items_units_per_pack_positive`) means SQLite requires a full table
-- rebuild, there being no `ALTER TABLE ... ADD CONSTRAINT`.
--
-- `stock_items` is a foreign-key **parent** of `stock_ledger`, which on a real
-- deployment holds a full stock history. `drizzle-kit generate` produced the
-- ordinary rebuild — create `__new_stock_items`, copy rows in, drop the old
-- table, rename the new one into place — and that ordering is exactly what
-- migration `0008` found broken: SQLite counts one deferred foreign-key
-- violation per `stock_ledger` row the moment `stock_items` is dropped, and
-- only an INSERT into the table now *named* `stock_items` brings that counter
-- back down before commit. Copying the rows in before the drop never touches
-- the counter, so the migration would pass against an empty database (the test
-- suite) and fail against any database that has ever taken a stock count.
--
-- Hence the `0008` recipe: park the existing rows under a throwaway name,
-- rebuild and rename, and only then copy them back in — which conveniently is
-- also where the grouping backfill happens, in the same INSERT, rather than a
-- separate UPDATE afterwards.
--
-- **The two `CHECK`s on `__new_stock_items` are deliberately unqualified**
-- (`CHECK("is_active" ...)`, not `CHECK("__new_stock_items"."is_active" ...)`).
-- `ALTER TABLE ... RENAME TO` has to rewrite the table name inside a `CHECK`
-- that names it, and a newer SQLite does not always do that silently — the
-- rename then fails with "no such column: __new_stock_items.is_active", after
-- `DROP TABLE stock_items` has already run and is not rolled back. `0022` and
-- `0032` hit the same trap and fixed it the same way; this one very nearly
-- reintroduced it.
--
-- `crates` and `crate_members` are new tables with no existing rows, so they
-- carry no such risk and are created the ordinary way once `stock_items` is
-- back in place.

CREATE TABLE `stock_take_groupings` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_take_groupings_name_unique` ON `stock_take_groupings` (`name`);
--> statement-breakpoint

-- The one seeded grouping every existing item backfills into below.
-- `ON CONFLICT DO NOTHING` makes a re-run safe, the same reasoning as `0007`.
INSERT INTO `stock_take_groupings` (`id`, `name`, `created_at`, `updated_at`)
VALUES (
	'4c55e811-9b7c-482c-ab4c-a700876d49bd',
	'Non-perishable',
	'2026-09-05T00:00:00.000Z',
	'2026-09-05T00:00:00.000Z'
)
ON CONFLICT (`name`) DO NOTHING;
--> statement-breakpoint

PRAGMA defer_foreign_keys=on;
--> statement-breakpoint
CREATE TABLE `__parked_stock_items` AS SELECT
	`id`, `name`, `name_normalised`, `description`, `category`, `shelf_number`,
	`shelf_sort_key`, `low_stock_threshold`, `is_active`, `created_at`, `updated_at`
FROM `stock_items`;
--> statement-breakpoint
CREATE TABLE `__new_stock_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_normalised` text NOT NULL,
	`description` text,
	`category` text DEFAULT 'Uncategorised' NOT NULL,
	`shelf_number` text NOT NULL,
	`shelf_sort_key` text NOT NULL,
	`low_stock_threshold` integer,
	`grouping_id` text,
	`units_per_pack` integer,
	`pack_unit_label` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`grouping_id`) REFERENCES `stock_take_groupings`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_items_is_active_boolean" CHECK("is_active" IN (0, 1)),
	CONSTRAINT "stock_items_units_per_pack_positive" CHECK("units_per_pack" IS NULL OR "units_per_pack" > 0)
);
--> statement-breakpoint
DROP TABLE `stock_items`;
--> statement-breakpoint
ALTER TABLE `__new_stock_items` RENAME TO `stock_items`;
--> statement-breakpoint

-- The insert that settles the deferred foreign-key counter, and the grouping
-- backfill, in one statement. No crate can exist yet, so every item here is
-- backfilled as directly grouped rather than as a crate member.
INSERT INTO `stock_items` (
	`id`, `name`, `name_normalised`, `description`, `category`, `shelf_number`,
	`shelf_sort_key`, `low_stock_threshold`, `grouping_id`, `units_per_pack`,
	`pack_unit_label`, `is_active`, `created_at`, `updated_at`
)
SELECT
	`id`, `name`, `name_normalised`, `description`, `category`, `shelf_number`,
	`shelf_sort_key`, `low_stock_threshold`,
	'4c55e811-9b7c-482c-ab4c-a700876d49bd', NULL, NULL,
	`is_active`, `created_at`, `updated_at`
FROM `__parked_stock_items`;
--> statement-breakpoint
DROP TABLE `__parked_stock_items`;
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_items_name_normalised_unique` ON `stock_items` (`name_normalised`);
--> statement-breakpoint
CREATE INDEX `idx_stock_items_shelf` ON `stock_items` (`shelf_sort_key`);
--> statement-breakpoint
CREATE INDEX `idx_stock_items_name` ON `stock_items` (`name_normalised`);
--> statement-breakpoint

CREATE TABLE `crates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`shelf_key` text NOT NULL,
	`grouping_id` text NOT NULL,
	`size_per_crate` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`grouping_id`) REFERENCES `stock_take_groupings`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "crates_size_per_crate_positive" CHECK("crates"."size_per_crate" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crates_shelf_key_unique` ON `crates` (`shelf_key`);
--> statement-breakpoint
CREATE TABLE `crate_members` (
	`crate_id` text NOT NULL,
	`stock_item_id` text NOT NULL,
	`stock_composition_percent` integer NOT NULL,
	`shopping_composition_percent` integer NOT NULL,
	PRIMARY KEY(`crate_id`, `stock_item_id`),
	FOREIGN KEY (`crate_id`) REFERENCES `crates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stock_item_id`) REFERENCES `stock_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "crate_members_stock_percent_range" CHECK("crate_members"."stock_composition_percent" BETWEEN 0 AND 100),
	CONSTRAINT "crate_members_shopping_percent_range" CHECK("crate_members"."shopping_composition_percent" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE INDEX `idx_crate_members_stock_item` ON `crate_members` (`stock_item_id`);
