-- A referral is no longer cancelled with a reason of its own: the administrator
-- writes why into the administrators' note, saved with the cancellation
-- (INITIAL_SPEC1.txt, #Referral maintenance). The charity does not want the
-- reasons already recorded kept. Session cancellation keeps its own
-- `sessions.cancelled_reason`; this is the referrals column only.
-- Not in any index, CHECK or foreign key, so a plain DROP COLUMN: no rebuild.
ALTER TABLE `referrals` DROP COLUMN `cancelled_reason`;
