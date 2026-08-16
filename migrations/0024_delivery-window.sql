-- A session's delivery time becomes a window: the span the food bank tells a
-- household to expect their delivery in, rather than a single moment a van
-- round cannot keep. See `INITIAL_SPEC1.txt`, "Session maintenance", and
-- `src/modules/sessions/delivery-window.ts` for the fallback rule.
--
-- ## No rebuild needed, and no rename either
--
-- `delivery_time` is named in no index, no CHECK and no foreign key — it was
-- added by a plain `ALTER TABLE ... ADD COLUMN` in `0017` — so `DROP COLUMN`
-- is legal here without the rebuild dance `0008`'s header describes. Both
-- `sessions` and `recurring_sessions` are foreign-key parents, so a generated
-- drop-and-recreate would have been data loss, not a migration; this is
-- neither.
--
-- Dropping rather than renaming `delivery_time` into one of the two new
-- columns is deliberate, not an oversight `drizzle-kit` was talked out of. A
-- moment is not a window, and there is no honest conversion from one to the
-- other — renaming would leave every existing row with one end of the window
-- set and the other missing, which is exactly the half-a-window state the
-- application refuses to store. Sessions that had a `delivery_time` simply
-- fall back to their own hours (`start_time` to `start_time` plus
-- `duration_minutes`) until an administrator types a real window in. There is
-- no production system yet, so what this drops is local data and whatever the
-- test system holds — where re-typing a window costs an administrator a
-- minute, and the alternative was carrying a half-set one forever.
ALTER TABLE `recurring_sessions` ADD `delivery_window_start` text;--> statement-breakpoint
ALTER TABLE `recurring_sessions` ADD `delivery_window_end` text;--> statement-breakpoint
ALTER TABLE `recurring_sessions` DROP COLUMN `delivery_time`;--> statement-breakpoint
ALTER TABLE `sessions` ADD `delivery_window_start` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `delivery_window_end` text;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `delivery_time`;
