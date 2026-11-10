-- The surname can be searched on by its beginning, by itself or narrowing the
-- other identifiers (INITIAL_SPEC1.txt, #Searching for a referral), through
-- this settled twin, the same shape as the postcode and phone ones.
--
-- **The previous server does NOT keep this column up to date**, so the usual
-- migrate-then-deploy gap is not harmless here: a referral submitted or
-- re-named between the two steps gets no settled surname and cannot be found
-- by it. After deploying, run the backfill statement below once more; it only
-- touches rows still missing the column. (docs/operations/release-pipeline.md,
-- "Migrate before deploying".)
ALTER TABLE `referrals` ADD `referee_surname_normalised` text;--> statement-breakpoint
CREATE INDEX `idx_referrals_search_surname` ON `referrals` (`referee_surname_normalised`);--> statement-breakpoint
-- Backfill. Every write from now on settles the surname in TypeScript
-- (`normaliseSurname`: NFC, leading whitespace off, every letter lowered).
-- SQLite has only ASCII `lower()` and no NFC, so this is an approximation of
-- that: a surname holding a non-ASCII capital (`Ünsal`) keeps the capital and
-- is not found by its surname until that surname is next corrected (a copy or
-- re-referral of it is settled afresh), and an accent stored decomposed stays decomposed. Plain-ASCII surnames —
-- nearly all of them — settle exactly as a new one would.
UPDATE `referrals` SET `referee_surname_normalised` = lower(trim(`referee_surname`))
WHERE `referee_surname_normalised` IS NULL AND `referee_surname` IS NOT NULL;
