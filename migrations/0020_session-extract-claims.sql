-- Extracting confirmed sessions to the charity's Google spreadsheet, per
-- `INITIAL_SPEC1.txt`, "Sending referrals to the spreadsheet".
--
-- **The server never talks to Google.** The administrator's browser holds the
-- Google credential, reads a session's referrals from this API, writes them to
-- the spreadsheet itself, and only then tells the server to mark the session
-- extracted. So what lives here is a queue and a reservation, nothing more.
--
-- `extracted_at IS NULL` is the queue. A marker on the row rather than a
-- cursor over `confirmed_at`, because stamp order is not commit order on
-- Workers: a session stamped microseconds early but committed late would sit
-- behind a cursor forever and never be extracted. A row that commits late is
-- still NULL, so the next batch takes it.
--
-- The three `extract_claim_*` columns are the reservation. The browser takes
-- one session at a time and holds a claim on it between being handed the
-- referrals and reporting the write done, so two administrators working the
-- queue together cannot both extract the same session.
--
-- `extract_claim_expires_at` is what makes a closed laptop recoverable. The
-- browser holds the only Google credential and the only knowledge of whether
-- the write happened, so if it goes away mid-session nothing can finish the
-- job — without an expiry that session would be reserved forever and the queue
-- would stop dead at it.
--
-- No personal data in any of these: they are facts about a session, not about
-- a household. So this is a plain `ALTER TABLE ADD COLUMN` per column and not
-- a rebuild. No backfill — every existing session is unextracted and
-- unclaimed, which is exactly what NULL already means.
--
-- The partial index keeps the queue scan proportional to the unextracted tail
-- rather than to an ever-growing table. `idx_sessions_extract_claim` is for
-- the other direction: completion arrives holding a claim id and nothing else.

ALTER TABLE `sessions` ADD `extracted_at` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `extract_claim_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `extract_claimed_by_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `sessions` ADD `extract_claim_expires_at` text;--> statement-breakpoint
CREATE INDEX `idx_sessions_unextracted` ON `sessions` (`extracted_at`) WHERE "sessions"."extracted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_sessions_extract_claim` ON `sessions` (`extract_claim_id`);