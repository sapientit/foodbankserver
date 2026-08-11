-- The referral asks for the household in four age bands, per
-- `INITIAL_SPEC1.txt`, the referral form section: infants 0-3, children 4-11,
-- teenagers 12-17, adults 18+.
--
-- `adults` and `children` stay, and stay meaning what everything operational
-- already takes them to mean — the 5x6 grid, the `parcels` snapshot, the
-- divergence check, `familySize` in the client's preference rules. They are now
-- **derived** on every write: `children` is the 4-11 count, `adults` is the
-- 12-17 count plus the 18+ count, and infants are ignored. Keeping them as
-- columns rather than deriving them in SQL on every read keeps that rule in one
-- place (`modules/referrals/age-bands.ts`) instead of two.
--
-- ## Why this is four ADD COLUMNs and not a rebuild
--
-- These are counts, not personal data, so nothing here needs to be nullable for
-- the purge to reach it — and no existing CHECK has to change. The rule the
-- charity asked for is "at least one person aged twelve or over", which is
-- exactly `adults >= 1` once `adults` is derived, and the table's existing
-- `referrals_household_not_empty` (`adults + children > 0`) still holds under
-- it. So there is no reason to rebuild a table that is the foreign-key parent
-- of `parcels` and that holds live personal data. See `0008` for what that
-- costs when it is genuinely unavoidable.
--
-- `NOT NULL` needs a default here because the table has rows; SQLite will not
-- add a NOT NULL column without one. The Zod schema requires all four on the
-- way in, so the default is a migration mechanism rather than an invitation to
-- omit them.
--
-- The bound is `>= 0` in SQL and 0-30 in Zod, matching `adults` and `children`
-- exactly. An upper bound in SQL would be a new way for the backfill below to
-- fail on a row that predates the Zod limit, in exchange for re-stating a rule
-- the edge already enforces.

ALTER TABLE `referrals` ADD `infants` integer DEFAULT 0 NOT NULL CHECK("infants" >= 0);--> statement-breakpoint
ALTER TABLE `referrals` ADD `children_4_to_11` integer DEFAULT 0 NOT NULL CHECK("children_4_to_11" >= 0);--> statement-breakpoint
ALTER TABLE `referrals` ADD `teenagers_12_to_17` integer DEFAULT 0 NOT NULL CHECK("teenagers_12_to_17" >= 0);--> statement-breakpoint
ALTER TABLE `referrals` ADD `adults_18_plus` integer DEFAULT 0 NOT NULL CHECK("adults_18_plus" >= 0);--> statement-breakpoint
-- The backfill is a **compatibility statement, not a claim about the
-- household**. Nobody asked these referrers how old anyone was, and this
-- migration must not invent an answer: what it preserves is the parcel each
-- existing household would get, and nothing more.
--
-- Putting the legacy `children` into the 4-11 band and the legacy `adults` into
-- the 18+ band is the only assignment that derives back to the same pair, so
-- every existing referral resolves to the same grid cell and the same model
-- parcel after this migration as before it. Infants and teenagers go to zero
-- because zero is what the food bank knows about them.
UPDATE `referrals` SET `children_4_to_11` = `children`, `adults_18_plus` = `adults`;
