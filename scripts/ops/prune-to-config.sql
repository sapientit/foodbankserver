-- Reduces a copy of a deployed database to configuration only, so it can seed
-- another environment: test → UAT (rehearsed 2026-09-29), UAT → production.
-- Run by `scripts/ops/build-seed.mjs` against an in-memory copy, never against a
-- deployed database: raw SQL here bypasses the ledger and audit rules the app
-- enforces, which is acceptable once, on a copy, and nowhere else.
--
-- Children before parents. The copy runs with foreign keys on and not
-- deferred, so a statement in the wrong order fails here rather than leaving a
-- dangling row to be found in production.
--
-- Kept whole, deliberately (Pete, 2026-10-11):
--   * retired stock items, and so their crate memberships;
--   * every referral-form release, superseded and draft included, and the
--     publication history. The configuration workbook is the same in every
--     environment, so a form change must meet the same releases everywhere.
-- Also kept: weekly session templates, crates, groupings, model parcels, the
-- household grid, target stock lists and the voucher configuration.

-- Households and everything that happened to them.
DELETE FROM sms_messages;
DELETE FROM stock_ledger;
DELETE FROM parcel_lines;
DELETE FROM parcels;
DELETE FROM pick_lists;
DELETE FROM referral_imports;
DELETE FROM audit_events;
DELETE FROM referrals;

-- Dated sessions go; the nightly job materialises them again from the
-- templates. Templates that have ended go too.
DELETE FROM sessions;
DELETE FROM recurring_sessions WHERE active_until IS NOT NULL AND active_until < date('now');

-- Sign-ins and the source system's own bookkeeping, which describes the source
-- account and not the target.
DELETE FROM refresh_tokens;
DELETE FROM volunteer_codes;
DELETE FROM system_jobs;
DELETE FROM platform_daily_stats;

-- Retired lookups. Retired reasons are deletable only because every referral
-- and import that named one is already gone above.
DELETE FROM authorised_referrers WHERE is_active = 0;
DELETE FROM referral_reasons WHERE is_active = 0;

-- Retired users, except anyone a kept release or publication names.
DELETE FROM users
WHERE is_active = 0
  AND id NOT IN (SELECT created_by_user_id FROM configuration_releases WHERE created_by_user_id IS NOT NULL)
  AND id NOT IN (SELECT published_by_user_id FROM configuration_releases WHERE published_by_user_id IS NOT NULL)
  AND id NOT IN (SELECT actor_user_id FROM configuration_release_publications);
