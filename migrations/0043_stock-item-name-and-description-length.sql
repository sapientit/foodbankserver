-- A stock item's name is at most 40 characters and its description at most
-- 50 (INITIAL_SPEC1.txt, "#Stock maintenance", settled 2026-10-12). Adding a
-- CHECK means a full rebuild of `stock_items`, there being no `ALTER TABLE ...
-- ADD CONSTRAINT`.
--
-- **This migration fails, rather than truncates, on a database holding a
-- longer name or description.** That is deliberate: a name cut short could
-- collide with another item's, and the charity's words are not ours to cut.
-- Measured before writing it: UAT's longest name was 23 and description 49,
-- the personal test system's 28 and 49.
--
-- `stock_items` is a foreign-key **parent** of `stock_ledger`, `parcel_lines`
-- and `crate_members` — none of them `ON DELETE CASCADE` — so this is `0034`'s
-- recipe, not the generated create-copy-drop-rename: park the rows under a
-- throwaway name, rebuild and rename, and only then insert them back, because
-- only an INSERT into the table now named `stock_items` brings SQLite's
-- deferred foreign-key counter back down (migration `0008`). `PRAGMA
-- defer_foreign_keys=on` replaces the generated `PRAGMA foreign_keys=OFF`,
-- which is a silent no-op on D1.
--
-- Every `CHECK` is unqualified (`CHECK("name" ...)`, not
-- `CHECK("__new_stock_items"."name" ...)`): a current SQLite does not rewrite
-- the qualified form on `RENAME TO`, and the rename then fails after the
-- `DROP TABLE` has already run. See docs/engineering/d1-constraints.md.

PRAGMA defer_foreign_keys=on;
--> statement-breakpoint
CREATE TABLE `__parked_stock_items` AS SELECT
	`id`, `name`, `name_normalised`, `description`, `category`, `shelf_number`,
	`low_stock_threshold`, `grouping_id`, `units_per_pack`, `pack_unit_label`,
	`is_active`, `created_at`, `updated_at`
FROM `stock_items`;
--> statement-breakpoint
CREATE TABLE `__new_stock_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_normalised` text NOT NULL,
	`description` text,
	`category` text DEFAULT 'Uncategorised' NOT NULL,
	`shelf_number` text NOT NULL,
	`low_stock_threshold` integer,
	`grouping_id` text,
	`units_per_pack` integer,
	`pack_unit_label` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`grouping_id`) REFERENCES `stock_take_groupings`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_items_is_active_boolean" CHECK("is_active" IN (0, 1)),
	CONSTRAINT "stock_items_units_per_pack_positive" CHECK("units_per_pack" IS NULL OR "units_per_pack" > 0),
	CONSTRAINT "stock_items_name_length" CHECK(length("name") <= 40),
	CONSTRAINT "stock_items_description_length" CHECK("description" IS NULL OR length("description") <= 50)
);
--> statement-breakpoint
DROP TABLE `stock_items`;
--> statement-breakpoint
ALTER TABLE `__new_stock_items` RENAME TO `stock_items`;
--> statement-breakpoint
INSERT INTO `stock_items` (
	`id`, `name`, `name_normalised`, `description`, `category`, `shelf_number`,
	`low_stock_threshold`, `grouping_id`, `units_per_pack`, `pack_unit_label`,
	`is_active`, `created_at`, `updated_at`
)
SELECT
	`id`, `name`, `name_normalised`, `description`, `category`, `shelf_number`,
	`low_stock_threshold`, `grouping_id`, `units_per_pack`, `pack_unit_label`,
	`is_active`, `created_at`, `updated_at`
FROM `__parked_stock_items`;
--> statement-breakpoint
DROP TABLE `__parked_stock_items`;
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_items_name_normalised_unique` ON `stock_items` (`name_normalised`);
--> statement-breakpoint
CREATE INDEX `idx_stock_items_shelf` ON `stock_items` (`shelf_number`);
--> statement-breakpoint
CREATE INDEX `idx_stock_items_name` ON `stock_items` (`name_normalised`);
