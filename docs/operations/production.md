# Going to production

## There are two deployments, and two databases

|                      | Test                                             | Production                      |
| -------------------- | ------------------------------------------------ | ------------------------------- |
| Worker               | `foodbank-server`                                | `foodbank-server-production`    |
| Wrangler environment | top-level (no `--env`)                           | `--env production`              |
| Deploy with          | `npm run deploy:test`                            | `npm run deploy`                |
| Migrate with         | `npm run db:migrate:test`                        | `npm run db:migrate:production` |
| D1 database          | `foodbank-test` (EU)                             | `foodbank` (EU)                 |
| URL                  | `https://foodbank-server.losttemple.workers.dev` | no application deployed         |

`foodbank-server-production` **does exist on the account**, but only as the empty shell that
`wrangler secret put --env production` created on 2026-07-29 — no application code, no route, and
it answers `404`. Its `foodbank` database is still at migration 0006. Treat production as unbuilt,
not as something already running.

`~/bin/foodbank-deploy-server` drives both: test by default, `--production` behind a typed
confirmation that also reports the `AUTH_MODE` tripwire and any uncommitted work.

**The two databases are separate on purpose**, for exactly the reason the two Google vars are: a
test deployment must not be able to write into the charity's real data. Both are EU-jurisdiction,
which is permanent. Never point one environment's `database_id` at the other's database.

The test system went up on 2026-08-08 on the **Cloudflare free plan**. It runs `ENVIRONMENT=development`
with `AUTH_MODE=dummy`, so the production tripwires below do not fire and anyone who knows a seeded
account's address can obtain an admin token. **It must never hold real personal data.** The seeded
`pete@x.com` from `migrations/0007_bootstrap-admin.sql` is committed in this repo and readable by
anyone, so the row's address was changed on the test database after migrating; do the same on any
future test database rather than leaving the published one live.

## The refresh cookie requires the frontend to be same-site

`auth.routes.ts` sets the refresh cookie `SameSite=Strict`. Browsers decide "same site" from the
**Public Suffix List**, and both `workers.dev` and `pages.dev` are on it — so `app.pages.dev` and
`foodbank-server.workers.dev` are as unrelated to a browser as two different companies. The cookie
is never sent, the fifteen-minute access token cannot be refreshed, and the session dies looking
exactly like an auth bug.

**Settled 2026-08-08: the client Worker proxies.** It serves the app and forwards `/api/v1/**` here
over a Cloudflare service binding, so the browser only ever sees one origin. Nothing is cross-origin,
no preflight happens, and **`ALLOWED_ORIGINS` stays empty** — the same-origin default `cors.ts`
already describes as correct. No domain is required for this, and `SameSite=Strict` is untouched.

The two rejected alternatives, so neither is re-proposed as new: one registrable domain with two
subdomains (works, but needs a domain), and `SameSite=None` (works cross-site and deliberately gives
up the CSRF property described at `auth.routes.ts:72-76`).

**What this arrangement moves rather than removes.** The browser's IP now reaches this API only if
the proxy forwards it. `cf-connecting-ip` is read in two places — the rate limiter's bucket key
(`http/middleware/rate-limit.ts`) and Turnstile's `remoteip`
(`modules/referrals/public.routes.ts`) — and if the client Worker builds a fresh `Request` instead
of passing the original through, the header is lost, `clientKey` falls back to its literal, and
every visitor collapses into one bucket. `REFERRAL_LIMITER` at 5/60s would then throttle the whole
public referral form. **Nothing on this side can detect that**, so it is written up as a requirement
in `API.md` along with the other three (proxy path-for-path, or the cookie's `/api/v1/auth` scope
never matches; return `Set-Cookie` intact; forward `authorization` and `cf-turnstile-response`).

## The spreadsheet extract needs a domain before go-live

Google requires an OAuth client's Authorised JavaScript origin to be a domain you own or can
verify, and `pages.dev` cannot be verified — Cloudflare owns it. That does **not** block a test
system: while the consent screen is in **Testing** status no verification is required, up to 100
named test users can consent past an "unverified app" warning, and each authorisation lasts seven
days before they re-consent.

It does block go-live. The Sheets scope is a **sensitive** scope, so the charity's real extract
needs a published, verified app, and verification requires an authorised domain that can be proved.
A domain is therefore a go-live prerequisite for the extract as well as for the cookie above.

## The Worker refuses to start on an unsafe configuration

`config/env.ts` has two tripwires, both deliberate. **Do not relax them to get a deploy out; fix the
configuration.**

| Tripwire                                | Why                                                |
| --------------------------------------- | -------------------------------------------------- |
| `AUTH_MODE=dummy` in production         | An open admin panel over real names and addresses. |
| No `TURNSTILE_SECRET_KEY` in production | An open, unauthenticated write with no bot check.  |

## Before anything holding real data is publicly reachable

1. `wrangler secret put AUTH_JWT_SECRET --env production` — minimum 32 characters. It has no
   default on purpose: a missing signing key must stop the Worker, not silently produce forgeable
   tokens. **Already set** (2026-07-29), which is also what brought the empty
   `foodbank-server-production` Worker into existence — `wrangler secret put` creates the Worker if
   it is absent. Rotate it rather than assume it needs creating.
2. Create a Turnstile widget, then `wrangler secret put TURNSTILE_SECRET_KEY --env production`.
3. Set `ALLOWED_ORIGINS` if the frontend is on a different origin. **Never a wildcard** — this API
   sends a refresh cookie, and `*` cannot carry credentials, so the "fix" would be reflecting
   whatever `Origin` arrives, which is no policy at all. Empty means same-origin only, which is
   correct if the frontend ships as Workers static assets.
4. Implement Google auth. `AUTH_MODE=google` currently means "no way to log in".
5. Set `PII_RETENTION_DAYS=365` — the period is settled; see below.
6. Set the spreadsheet extract's two values, if and when the charity wants it running. **Neither is
   a secret and neither is a Google credential** — the server has none. They are plain `vars` in
   `wrangler.jsonc`, with **different values per environment**, so a test deployment cannot write
   into the charity's real spreadsheet:
   - `GOOGLE_SHEETS_SPREADSHEET_ID` — the spreadsheet to write into.
   - `GOOGLE_OAUTH_CLIENT_ID` — the public OAuth client the browser requests Sheets consent
     against. It needs the Sheets scope and the frontend's origin as an authorised JavaScript
     origin; that setup is in the Google Cloud console, not here.

   Both are blank in the production block until somebody fills them in, and blank means unset: the
   extract reports itself unconfigured and refuses rather than the Worker failing to boot.

   Two things to be deliberate about before turning it on, both the charity's to weigh and neither
   enforceable from here: **residency** — a Workspace with EU data regions keeps the residency the
   D1 jurisdiction was chosen for, a personal Gmail account does not — and the fact that **the
   twelve-month purge cannot reach the spreadsheet**. See
   [`../engineering/personal-data.md`](../engineering/personal-data.md).

   Note there is nothing to `wrangler secret put` here. If you find yourself creating a Google
   service account for this, stop: that design was built and deliberately replaced by one where the
   administrator's own browser does the writing.

## What is already enforced at runtime

**Rate limiting** uses Cloudflare's Rate Limiting binding — no npm dependency and no state of our
own — applied per route on every unauthenticated endpoint. `REFERRAL_LIMITER` (5 requests / 60s)
guards `POST /public/referrals`; `PUBLIC_LIMITER` (60 / 60s) guards the rest of the public surface.

It keys on **`cf-connecting-ip`**, which Cloudflare sets and a client cannot spoof. **Never key on
`x-forwarded-for`.** Without the header (local dev) everything shares one bucket, which is harmless.

**The binding is optional at runtime**: it does not exist in the test runner or a plain
`wrangler dev`, and a missing binding must not take the whole API down, so an absent limiter is
skipped. Production safety therefore lives in the configuration tripwires above, not here.

**Turnstile** is verified on `POST /public/referrals` before the body is parsed or anything is
written. Three things about the Cloudflare API, all easy to get wrong:

- a token can be validated **once** — a replay returns `timeout-or-duplicate`, so verification must
  happen exactly once per submission and never inside a retry loop;
- tokens **expire after 300 seconds**, so a referrer filling the form in slowly will fail — that is
  a real message the frontend has to handle;
- `idempotency_key` makes a network retry of the _verification_ safe, which is not the same as
  retrying the submission.

Verification is skipped when no secret is configured, which can only mean development, because
production refuses to boot without one.

**CORS** is an allowlist applied app-wide. An unknown origin gets no CORS headers, and its preflight
is refused with a `403` rather than answered.

## Retention

The period is **twelve months**, settled by the charity on 2026-08-06 (`INITIAL_SPEC1.txt`,
`#Forgetting a referral`). `PII_RETENTION_DAYS` is nonetheless still **unset**, so the purge runs
nightly and purges nothing. Setting it to `365` is the whole change — and it is the moment the
system starts deleting personal data, which is why it is a deliberate step at go-live rather than
something already done.

Twelve months is also the lookback the repeat-referral count on the review screen depends on. Do not
shorten one without the other: a shorter retention makes that count under-report silently.

## Migrating production the first time

Production is at `0006` and has every migration since ahead of it. **Four of them — `0008`, `0015`,
`0016` and `0018` — rebuild a table using a `CHECK` that names its column qualified
(`"__new_x"."col"`), which depends on SQLite rewriting the reference during `ALTER TABLE … RENAME
TO`.** D1's SQLite does rewrite it, which is why the test database took all twenty-one cleanly on
2026-08-08. SQLite 3.51 does not, and on that version the migration fails **after** its `DROP TABLE`
has run — old table gone, no renamed one to replace it.

So do not run the first production migration unattended:

- Migrate when a Time Travel restore point exists and you can watch it.
- Afterwards, check the rebuilt tables are actually there — `referrals`, `stock_ledger`, `users`.
- If one has vanished, restore to the point in time and stop; do not re-run.

Nothing needs rewriting today and rewriting applied migrations would be its own risk. The reasoning
and the reproduction are in
[`../engineering/d1-constraints.md`](../engineering/d1-constraints.md); migration `0022` onwards
avoids the construct.

## Backups

**Time Travel is the backup** — **7 days on the free plan**, 30 on paid, whole-database restore
only. You cannot restore one table. Plan any destructive migration on the basis that the rollback is
"restore everything to a point in time".

## What the free plan costs us

The test system runs on the free plan. Two of these are real constraints on behaviour, not just
headroom:

| Limit                          | Free      | Paid          | Bites                                                                                                                                                                      |
| ------------------------------ | --------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subrequests per invocation** | **50**    | 10,000        | **Yes.** SMS sending issues one outbound `fetch` per household, so a session of more than ~48 households cannot be texted in a single invocation.                          |
| **CPU per invocation**         | **10 ms** | 30 s          | **Possibly.** Applies to cron invocations too. D1 wait does not count, so most routes are safe; pick-list generation is the one to watch. Unproven — see below.            |
| D1 queries per invocation      | 50        | 1,000         | Already designed around — see the query-budget note in `materialise-sessions.ts`. The PII purge is the known violator and stays inert while `PII_RETENTION_DAYS` is unset. |
| Requests per day               | 100,000   | —             | No.                                                                                                                                                                        |
| Cron triggers per account      | 5         | —             | No — one trigger, as the config comment says.                                                                                                                              |
| D1 databases / storage         | 10 / 5 GB | 50,000 / 1 TB | No.                                                                                                                                                                        |

**These limits are per _account_, not per Worker**, and this account also runs an unrelated Worker,
`losttemple-api`. The two share the 100,000 daily requests, the D1 storage and row budgets, and the
five cron triggers. The coupling that matters: **exceeding the daily request cap returns error 1027
for every Worker on the account**, so a bot hammering the public referral form could take the other
Worker down with it. That is an argument for moving to the paid plan, or a separate account, before
the referral form is advertised to anybody.

Do **not** rename the `workers.dev` subdomain to something food-bank-ish. It is account-wide and
would change the other Worker's URL too. Get a domain instead.

**Rate limiting works on the free plan** — verified against the deployed test system: 60 sequential
posts to `POST /public/referrals` (limit 5/60s) returned 43 × `429`. But it is **permissive and
eventually consistent by design**, and Cloudflare says so: a short or heavily parallel burst gets
through before the counter propagates. 12 rapid posts against the same 5/60s limiter produced no
`429` at all. Treat it as protection against sustained abuse, not as an exact gate — and never write
a test that asserts the Nth request is refused.

**The 10 ms CPU ceiling is not yet proven.** The scheduled job has only been run against an empty
database, where it considered zero templates. It needs re-running once the test system has real
recurring sessions and referrals in it, and the first unattended 02:17 run should be checked in
Workers Logs.

## Scheduled work

One cron trigger, `17 2 * * *`, runs everything: session materialisation (six weeks ahead), expiry
of referral edit keys, and the PII purge. One trigger rather than three because the free plan allows
only five per account and there is no reason to spend more.

`runScheduledJobs` is shared by the cron handler and the admin trigger route, so the thing that runs
unattended at 02:17 is exactly the thing exercised by hand and by tests — not a parallel
implementation of it. It is idempotent: a second run creates nothing.

## First-time database creation

A database must be created with the EU jurisdiction, because it holds UK personal data, and **this
cannot be changed afterwards**:

```bash
npx wrangler d1 create foodbank --jurisdiction=eu       # production
npx wrangler d1 create foodbank-test --jurisdiction=eu  # test
```

Both already exist. Paste the returned `database_id` into the matching block in `wrangler.jsonc` —
top-level for test, `env.production` for production — and never into both.

See `README.md` for the rest of the first-run setup.
