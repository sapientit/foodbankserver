-- Marks a `reminder` or `staff_reply` row that was never actually sent through
-- TheSMSWorks: the dev/test simulator (`SMS_SIMULATE`), or a destination
-- outside the one allowed live number (`SMS_LIVE_NUMBER`) in a restricted test
-- environment. See `config/env.ts` and `modules/sms/sms.service.ts`.
--
-- No personal data in this column — it says whether the provider was really
-- called, not anything about the household — so this is a plain
-- `ALTER TABLE ADD COLUMN` and not a rebuild, the same as `migrations/0027`.
--
-- Defaults every existing row to `false`: nothing before this column existed
-- was ever simulated, since the feature did not exist yet.

ALTER TABLE `sms_messages` ADD `simulated` integer DEFAULT false NOT NULL;
