-- The administrator SMS inbox, per `INITIAL_SPEC1.txt`, "SMS reminders and
-- replies". An administrator needs to know whether an unread household reply
-- belongs to a session that is still open (the team leader's business) or one
-- that has closed (nobody else is coming back to it).
--
-- `session_id` is a snapshot taken once, at insert, of `referral.session_id`
-- as it stood at that moment — never re-derived later by joining through the
-- referral. `referrals.service.ts`'s `move()` overwrites `referrals.session_id`
-- in place, with no cascade to this table, so a message's own session would
-- silently follow the household to wherever it is moved next if this were
-- computed live instead of stored. Null means the same as a null
-- `referral_id`: no session was known when the row was written, and the
-- administrator inbox treats that as a loose reply.
--
-- No personal data in this column — it is a fact about which session a
-- message belongs to, not about a household — so this is a plain
-- `ALTER TABLE ADD COLUMN` and not a rebuild, the same as `migrations/0020`.
-- No backfill: every existing row predates this column and has nothing
-- reliable to backfill it from, so it stays NULL and reads as a loose reply.

ALTER TABLE `sms_messages` ADD `session_id` text REFERENCES sessions(id);--> statement-breakpoint
CREATE INDEX `idx_sms_messages_session` ON `sms_messages` (`session_id`);
