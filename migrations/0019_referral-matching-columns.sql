-- Two columns and three indexes for repeat-referral detection at review. See
-- `INITIAL_SPEC1.txt`, "Reviewing a referral".
--
-- `referee_postcode_normalised` and `referee_phone_normalised` hold the
-- settled form of the postcode and phone number the referrer typed —
-- uppercased and whitespace-stripped for the postcode, UK E.164 for the
-- phone — so that matching can compare `"gu1 4aa"` with `"GU1 4AA"`. Both are
-- nullable and both sit in the PII block: they are derived from personal
-- data and are personal data, purged alongside the columns they come from.
--
-- Three single-column indexes, not one composite: the match predicate is an
-- OR across date of birth, postcode and phone, and SQLite serves an OR by
-- index union — a composite index cannot help it.
--
-- This is a pure add. Nothing here is a CHECK or a rebuild, so `ALTER TABLE
-- ... ADD COLUMN` is enough; see `0017`'s header for why that matters.
--
-- ## The backfill, and why it duplicates a rule that lives in TypeScript
--
-- The authoritative rule for both settled forms lives in TypeScript —
-- `src/modules/referrals/matching.ts` for the postcode,
-- `src/core/phone.ts` for the phone — and every future write goes through
-- it. SQLite has no `REGEXP`, so the statements below are a one-time
-- restatement of that same rule for rows that already exist, expressed as
-- `replace`, `upper`, `substr` and `GLOB` instead of a regular expression.
-- The six postcode `GLOB`s enumerate exactly the shapes
-- `^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$` matches. Duplication across two
-- languages is the cost of a one-off migration; a table of rows that
-- silently never match would cost more.
--
-- The whole sequence is **idempotent and re-runnable**, and that is a
-- property of the sequence rather than of each statement in it. The first
-- statement of each pair recomputes the normalised column from the untouched
-- source column (`referee_postcode`, `referee_phone`); the ones after it
-- refine what that wrote. So running the whole thing twice, or against a
-- database where some rows are already normalised and some are not, produces
-- the same result either way — but re-running one of the phone prefix
-- statements on its own would not, because they read the column they write.
--
-- ## A GLOB pattern here may not exceed 50 characters
--
-- SQLite refuses a LIKE or GLOB pattern longer than 50 characters with
-- `LIKE or GLOB pattern too complex`, and D1 enforces it — measured against
-- this repo's own binding, not assumed: a 48-character pattern runs and a
-- 53-character one throws.
--
-- The trap is that **SQLite only evaluates the pattern when there is a row to
-- evaluate it against**, so an over-long pattern runs perfectly well against
-- an empty table. Every test here applies the migrations to a fresh database,
-- so a broken one of these would pass the entire suite and then fail on the
-- first deployment that had any referrals in it. That is why the last
-- statement below spells out "+44 followed by ten digits" with `length`,
-- `substr` and one short `'*[^0-9]*'` rather than the obvious
-- `'+44[0-9]…[0-9]'`, which is 53 characters. The six postcode patterns are
-- all under 35 and are fine as they stand.
ALTER TABLE `referrals` ADD `referee_postcode_normalised` text;--> statement-breakpoint
ALTER TABLE `referrals` ADD `referee_phone_normalised` text;--> statement-breakpoint
CREATE INDEX `idx_referrals_match_dob` ON `referrals` (`referee_date_of_birth`);--> statement-breakpoint
CREATE INDEX `idx_referrals_match_postcode` ON `referrals` (`referee_postcode_normalised`);--> statement-breakpoint
CREATE INDEX `idx_referrals_match_phone` ON `referrals` (`referee_phone_normalised`);--> statement-breakpoint
UPDATE referrals
SET referee_postcode_normalised =
  upper(replace(replace(replace(referee_postcode, ' ', ''), char(9), ''), char(160), ''))
WHERE referee_postcode IS NOT NULL;
--> statement-breakpoint
UPDATE referrals
SET referee_postcode_normalised = NULL
WHERE referee_postcode_normalised IS NOT NULL
  AND referee_postcode_normalised NOT GLOB '[A-Z][0-9][0-9][A-Z][A-Z]'
  AND referee_postcode_normalised NOT GLOB '[A-Z][0-9][A-Z][0-9][A-Z][A-Z]'
  AND referee_postcode_normalised NOT GLOB '[A-Z][0-9][0-9][0-9][A-Z][A-Z]'
  AND referee_postcode_normalised NOT GLOB '[A-Z][A-Z][0-9][0-9][A-Z][A-Z]'
  AND referee_postcode_normalised NOT GLOB '[A-Z][A-Z][0-9][A-Z][0-9][A-Z][A-Z]'
  AND referee_postcode_normalised NOT GLOB '[A-Z][A-Z][0-9][0-9][0-9][A-Z][A-Z]';
--> statement-breakpoint
UPDATE referrals
SET referee_phone_normalised =
  replace(replace(replace(replace(replace(referee_phone, ' ', ''), char(9), ''), '-', ''), '(', ''), ')', '')
WHERE referee_phone IS NOT NULL;
--> statement-breakpoint
UPDATE referrals SET referee_phone_normalised = '+44' || substr(referee_phone_normalised, 5)
WHERE referee_phone_normalised GLOB '0044*';
--> statement-breakpoint
UPDATE referrals SET referee_phone_normalised = '+' || referee_phone_normalised
WHERE referee_phone_normalised GLOB '44*';
--> statement-breakpoint
UPDATE referrals SET referee_phone_normalised = '+44' || substr(referee_phone_normalised, 2)
WHERE referee_phone_normalised GLOB '0*';
--> statement-breakpoint
UPDATE referrals SET referee_phone_normalised = NULL
WHERE referee_phone_normalised IS NOT NULL
  AND NOT (
    length(referee_phone_normalised) = 13
    AND substr(referee_phone_normalised, 1, 3) = '+44'
    AND substr(referee_phone_normalised, 4) NOT GLOB '*[^0-9]*'
  );
