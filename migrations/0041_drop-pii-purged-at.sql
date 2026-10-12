-- The old retention purge stamped pii_purged_at when it nulled a referral's
-- personal columns. The purge now deletes the referral outright
-- (INITIAL_SPEC1.txt, #Forgetting a referral), so nothing sets or reads it.
-- Not in any index, CHECK or foreign key, so a plain DROP COLUMN: no rebuild.
-- No deployment ever set it.
ALTER TABLE `referrals` DROP COLUMN `pii_purged_at`;
