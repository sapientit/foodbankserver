-- The administrators' one line for the picker, read live onto every parcel of
-- the referral (INITIAL_SPEC1.txt, #Picking list). Nullable, no backfill.
ALTER TABLE `referrals` ADD `picklist_admin` text;--> statement-breakpoint
-- A parcel's notes now hold only the "No longer stocked" line written at
-- generation; the client composes the rest of the pick-list information each
-- time it shows or prints it. Every existing parcel holds the old composed
-- snapshot, which would print a second time beside the composed lines. The
-- charity confirmed there is no history in this field worth keeping.
UPDATE `parcels` SET `notes` = NULL;
