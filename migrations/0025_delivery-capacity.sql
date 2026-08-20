-- `deliveries_allowed` was purely informational — never enforced — and is
-- replaced by a numeric `delivery_capacity`: how many of a session's places
-- may be deliveries, bounded by but independent of the overall `capacity`. A
-- session that takes no deliveries is now one with `delivery_capacity = 0`;
-- there is no separate flag any more. See `INITIAL_SPEC1.txt`.
--
-- Existing sessions with `deliveries_allowed = 1` are backfilled to a
-- `delivery_capacity` of 8 — an editable starting point, not a claim about
-- any particular session's real delivery capacity. Sessions with
-- `deliveries_allowed = 0` become `delivery_capacity = 0`, which the column's
-- own `DEFAULT 0` already gives them.
--
-- ## No rebuild needed
--
-- `deliveries_allowed` was added by a plain `ALTER TABLE ... ADD COLUMN` in
-- `0017` and is named in no index, no CHECK and no foreign key on either
-- table, so `DROP COLUMN` is legal here without the rebuild dance `0008`'s
-- header describes. Both `sessions` and `recurring_sessions` are foreign-key
-- parents, so a generated drop-and-recreate would have been data loss, not a
-- migration; this is neither.
ALTER TABLE `recurring_sessions` ADD `delivery_capacity` integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `recurring_sessions` SET `delivery_capacity` = 8 WHERE `deliveries_allowed` = 1;--> statement-breakpoint
ALTER TABLE `recurring_sessions` DROP COLUMN `deliveries_allowed`;--> statement-breakpoint
ALTER TABLE `sessions` ADD `delivery_capacity` integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `sessions` SET `delivery_capacity` = 8 WHERE `deliveries_allowed` = 1;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `deliveries_allowed`;
