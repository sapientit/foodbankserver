-- Supports the administrator inbox's "does this phone number have anything
-- besides a reminder" check and the full-history scan once a number
-- qualifies — see `modules/sms/sms.repository.ts`, `listInbox`, and
-- `INITIAL_SPEC1.txt`, "SMS reminders and replies". Nothing queried this
-- table by `phone` before, so there was no index to reuse.

CREATE INDEX `idx_sms_messages_phone` ON `sms_messages` (`phone`,`occurred_at`);
