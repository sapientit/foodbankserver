-- Removes the derived `shelf_sort_key`. Shelf order is now a plain sort of
-- `shelf_number` as typed (`A10` before `A2`) — INITIAL_SPEC1.txt, "#Stock
-- maintenance". No table rebuild: `shelf_sort_key` is named only by
-- `idx_stock_items_shelf`, so dropping that index first lets `DROP COLUMN`
-- stand on its own. `stock_items` is a foreign-key parent, so this is the
-- generated output only because it happens not to be a rebuild — check that,
-- do not assume it (migration 0008 / .claude/rules/database.md).
DROP INDEX `idx_stock_items_shelf`;--> statement-breakpoint
CREATE INDEX `idx_stock_items_shelf` ON `stock_items` (`shelf_number`);--> statement-breakpoint
ALTER TABLE `stock_items` DROP COLUMN `shelf_sort_key`;