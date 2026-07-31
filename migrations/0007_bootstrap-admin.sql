-- The first administrator.
--
-- Logging in no longer creates an account, so without this row a freshly
-- migrated database has nobody who can create one — including nobody who can
-- create the person who creates everybody else. This is that starting point:
-- one admin, who adds the rest through POST /api/v1/users.
--
-- Data, not schema, so it is written by hand rather than by `drizzle-kit
-- generate`. Its snapshot is a copy of the previous one for that reason.
--
-- `ON CONFLICT DO NOTHING` makes it safe on a database that already has this
-- address, and — more to the point — stops a re-run resurrecting an account
-- that an admin has since renamed, demoted or deactivated.
--
-- `pete@x.com` is a stand-in, not the charity's address. It is replaced when
-- sign-in moves to Google, which is the moment it starts to matter: a Google
-- deployment resolves accounts by a real Google identity, and this row holds
-- none. Whoever does that work replaces the seed in the same change — see the
-- #Login section of INITIAL_SPEC1.txt.
INSERT INTO users (
	id,
	email,
	display_name,
	role,
	google_subject,
	is_active,
	last_login_at,
	created_at,
	updated_at
)
VALUES (
	'6814d1ea-eb23-4f09-919e-911c750e4a66',
	'pete@x.com',
	'Pete',
	'admin',
	NULL,
	1,
	NULL,
	'2026-07-30T00:00:00.000Z',
	'2026-07-30T00:00:00.000Z'
)
ON CONFLICT (email) DO NOTHING;
