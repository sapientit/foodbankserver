# Going to production

## There are four tiers: dev, test, UAT and production

**The account migration attempted 2026-09-21 was partly reverted 2026-09-22.** It had made the
charity's own account the top-level (default, no-`--env`) deploy target, but that broke
`deploy_foodbank` / `foodbank-deploy-server` — which assume no-`--env` means the old
personal-account `foodbank-server` — with a Cloudflare "database could not be found" error, because
the scripts and `wrangler.jsonc` no longer agreed on which account the default target meant.
Top-level was pointed back at the personal account to fix that. **Only the default-target wiring was
reverted — the charity-account system it had built kept running underneath it**, preserved as its
own Wrangler environment (`new-test` at the time, renamed `uat` on 2026-09-24 once it was formally
reinstated as a third, standing tier alongside test — additive, not a replacement for it).

|                      | Test (live)                                      | UAT                                              | Production                       |
| -------------------- | ------------------------------------------------ | ------------------------------------------------ | -------------------------------- |
| Account              | Personal                                         | Charity's own                                    | Charity's own                    |
| Worker               | `foodbank-server`                                | `api-test`                                       | `api`                            |
| Wrangler environment | top-level (no `--env`)                           | `--env uat`                                      | `--env production`               |
| Deploy with          | `npm run deploy:test`                            | `npm run deploy:uat`                             | `npm run deploy`                 |
| Migrate with         | `npm run db:migrate:test`                        | `npm run db:migrate:uat`                         | `npm run db:migrate:production`  |
| D1 database          | `foodbank-test` (EU, personal account)           | `foodbank-test` (EU, charity account)            | `foodbank` (EU)                  |
| Auth                 | `AUTH_MODE=dummy`                                | `AUTH_MODE=google`                               | `AUTH_MODE=google` (once set up) |
| URL                  | `https://foodbank-server.losttemple.workers.dev` | `https://api-test.guildfordfoodbank.workers.dev` | no application deployed          |

UAT signs in with real Google identities rather than dummy auth — deliberately, so Google sign-in is
proved on a live deployment before production depends on it. That also means the admin CLI tooling
that signs in via `POST /api/v1/auth/dev-login` (`scripts/load-stock-data.mjs`,
`foodbankclient/tools/validate-foodbank-takeon.mjs`) **cannot reach UAT** — that route is
deliberately not registered when `AUTH_MODE=google`. Giving those tools a real Google-authenticated
sign-in path is separate, unstarted work.

Driving UAT (or production) from `~/bin/foodbank-deploy-server` needs the charity account's
Cloudflare API token, since the account isn't the one the local `wrangler login` session is
authenticated as. The token is read from macOS Keychain
(`security find-generic-password -a "$USER" -s foodbank-charity-cloudflare-api-token -w`) rather
than exported by hand — see that script for the exact mechanism. **`CLOUDFLARE_ACCOUNT_ID` is pinned
alongside the token, not left to auto-detect** — confirmed 2026-09-24 that `wrangler whoami` reports
the right account from the token alone, but `wrangler d1`/`turnstile`/`deployments` calls on this
machine still resolved to the _personal_ account and failed, because a cached `wrangler login`
session for that account wins auto-discovery for those subcommands regardless of which token's env
var is set. Set both, always, for anything charity-account.

Confirmed working end to end 2026-09-24 with a freshly generated token: `wrangler whoami`, D1
migrations list, Turnstile widget list and Workers deployments list all succeeded against the
charity account once both env vars were set. The token needs Workers Scripts, D1, Turnstile Sites
and Account Settings Read permissions — no separate "Rate Limiting" permission exists for the
Workers `ratelimits` binding (that's provisioned as part of the script deploy itself, under Workers
Scripts); don't confuse it with the unrelated Zone WAF / Account Rulesets permissions, which are for
Cloudflare's WAF Rate Limiting Rules product, not this binding.

`api` **does exist on the charity account**, but only as the empty shell that `wrangler secret put
--env production` created on 2026-09-21 — no application code, no route, and it answers `404`. Its
`foodbank` database exists (EU jurisdiction) but is unmigrated. Treat production as unbuilt, not as
something already running.

`~/bin/foodbank-deploy-server` drives all three deployed tiers: test by default, `--uat` for the
charity-account UAT system, and `--production` behind a typed confirmation that also reports the
`AUTH_MODE` tripwire and any uncommitted work.

**The databases are separate on purpose**, for exactly the reason the Google vars differ per tier: no
deployment should be able to write into another's data. All are EU-jurisdiction, which is permanent.
Never point one environment's `database_id` at another's database.

The test system runs on the **Cloudflare free plan**, `ENVIRONMENT=development` with
`AUTH_MODE=dummy`, so the production tripwires below do not fire and anyone who knows a seeded
account's address can obtain an admin token. **Neither the test system nor UAT must ever hold real
personal data.** The seeded `pete@x.com` from `migrations/0007_bootstrap-admin.sql` is committed in
this repo and readable by anyone, so the row's login email was changed on the deployed test database
after migrating (local `wrangler dev` keeps the public default, since it's not reachable over the
network); do the same on any future test database rather than leaving the published one live.

## Migrating to the charity's own Cloudflare account

**Only this migration's default-target wiring was reverted, 2026-09-22** — the charity-account
system itself (what is now the `uat` environment) kept running underneath that revert and needed no
rebuilding when it was formally reinstated 2026-09-24. The checklist below is a historical record of
what was done: everything discovered while doing it (account id, database ids, worker names, the
Google sign-in client) is still valid and still in `wrangler.jsonc`, under the `uat` environment
(renamed from `new-test`) rather than left as the default target. See "There are four tiers" above
for the current state. Unchecked items below are genuinely still open — mostly things only Pete can
do (a TheSMSWorks value, a second API token) — not blockers on UAT being a working deployment today.

Everything today — **both** the deployed test system and the (unbuilt) production shell — runs on
one personal Cloudflare account (`ea7ad751ffa489bc577330c6eedd7500`), shared with an unrelated
Worker, `losttemple-api` (see the free-plan cost table below for why that coupling matters: one bot
on the referral form can `1027` both Workers). This checklist moves the whole system — test
deployment included, not just the production go-live — to an account the charity actually owns.

Each step is tagged **[Pete]** (needs a browser, a dashboard, an external account, or a judgement
call only you can make) or **[Claude]** (I can run it from here, in this session, once whatever it
depends on is done). Do everything tagged **[Claude]** by asking me, in order — I'll do as much of
this as I'm able to rather than hand it back to you piecemeal.

### 1. Access

- [x] **[Pete]** Create, or get admin access to, the charity's own Cloudflare account. Done —
      `pete@guildfordfoodbank.org`'s account, id `deb0c45ee0e89fad81d6b1227d7c439a`.
- [x] **[Pete]** Create an API token (**My Profile → API Tokens → Create Token**) scoped to Workers
      Scripts, D1 and Rate Limiting, plus D1 Edit added after the first attempt came up short. Done.
- [x] **[Claude]** Confirmed the token works and noted the new `CF_ACCOUNT_ID` above.

### 2. Account-scoped resources that can't be copied

D1 databases, Turnstile widgets and API tokens all belong to the account they were created under —
none of them move by copying a value, each has to be recreated against the new account.

- [x] **[Claude]** Created both D1 databases fresh, EU jurisdiction — `foodbank-test`
      (`7060fbc4-1b30-4d9d-b6ee-6c932c11a098`) and `foodbank` (`cd9d1e7a-170d-4e89-854f-f1ab02a549c0`)
      — and updated `wrangler.jsonc` with the returned ids.
- [x] **[Claude]** Updated `CF_ACCOUNT_ID` and `CF_D1_DATABASE_ID` in `wrangler.jsonc`'s `vars` for
      both environments and regenerated binding types (`npm run cf-typegen`).
- [x] **[Pete/Claude, 2026-09-21]** A Turnstile widget for the charity account, scoped to UAT's own
      frontend origin, exists: `referrals-test`, sitekey `0x4AAAAAAE-vkC8v_zmzPHVS`, domains
      `localhost` and `referrals-test.guildfordfoodbank.workers.dev`. This checkbox went unticked at
      the time even though the widget was created — the record was left incomplete, not the work.
- [x] **Confirmed 2026-09-24** via `wrangler secret list --env uat` (charity account): `api-test`
      already has `AUTH_JWT_SECRET`, `SMS_WEBHOOK_SECRET` and `TURNSTILE_SECRET_KEY` all set. Whether
      that `TURNSTILE_SECRET_KEY` value is genuinely this widget's own secret (rather than something
      left over from elsewhere) still can't be confirmed without a live referral submission through
      it — Cloudflare never returns a secret's value once set — but the key is present, not missing.

**Fixed on the personal account, 2026-09-23**: the live test system (`foodbank-server`) had no
`TURNSTILE_SECRET_KEY` set at all — Turnstile verification was being silently skipped there.
A widget already existed on this account (`foodbank-referral-test`, sitekey
`0x4AAAAAAEW-EE-GNrXmJW7R`, created 2026-08-20, scoped to `foodbank-client.losttemple.workers.dev`
and `localhost`), but its secret had apparently only been set on the charity account's paused
`api`/`api-test` Worker during the 2026-09-21 migration — the wrong account for what's actually
deployed since the revert. `TURNSTILE_SECRET_KEY` is now set on `foodbank-server` from that same
widget's secret. The charity account's copy — whatever value that was — was left as is (not
reachable with the credentials available at the time); decide whether to rotate or delete it, now
that `uat` is a real, documented tier rather than something pending rebuild.

- [ ] **[Pete]** (Optional — only if you want the platform-usage job running) create a second API
      token scoped to Analytics + D1 read, and give it to me. Dashboard path: **My Profile → API
      Tokens → Create Token → Custom token**, with **Account → D1 → Read** and **Account →
      Account Analytics → Read**, scoped to this account.
- [ ] **[Claude]** Set `CF_ANALYTICS_API_TOKEN` from what you give me, if you did the step above.

### 3. Secrets

- [x] **[Claude]** Generated `AUTH_JWT_SECRET` fresh (not reused from the old account) and set it via
      `wrangler secret put` for both environments, piped straight in — never typed or pasted anywhere.
      This also created the two empty Worker shells on the new account, same as `wrangler secret put`
      did on the old one — first as `foodbank-server`/`foodbank-server-production`, then recreated as
      `api-test`/`api` once the rename below was decided (the old-named shells were deleted).
- [x] **[Claude]** Generated and set `SMS_WEBHOOK_SECRET` the same way, both environments.
- [x] **[Claude]** Renamed the Workers from `foodbank-server`/`foodbank-server-production` to
      `api-test`/`api` (Pete's call, 2026-09-21) — the old names left no clean pattern for production
      once test got the `-test` suffix. Re-set both secrets above under the new names, deleted the
      old-named shells, and updated every reference across this repo (`wrangler.jsonc`, `openapi.yaml`,
      `README.md`, `API.md`, `STATUS.md`, this file).
- [ ] **[Pete]** Update TheSMSWorks' webhook configuration to the value I just set for
      `SMS_WEBHOOK_SECRET` — it's a shared secret with them, so their side has to match. Ask me for
      the value if you need it; I won't put it in chat unprompted.
- [x] **[Pete, 2026-09-25]** Set `SMS_API_KEY` (same TheSMSWorks account, carried over unchanged)
      on `production` and `uat`, piped from the clipboard through `~/bin/foodbank-charity-wrangler` so
      it never passed through a conversation. Confirmed present on both via `secret list`. That
      wrapper runs any wrangler command against the charity account (Keychain token, pinned account
      id): a plain `wrangler … --env production` on this machine goes to the **personal** account,
      which on 2026-09-25 created a stray `api` Worker there holding the key — deleted the same day.
- [x] **[Pete, 2026-09-25]** Set `SMS_LIVE_NUMBERS` (the testers' numbers) on `uat`. Required before
      the key there: the code UAT is currently running treats a key with no list as texting
      everyone. From the fix of 2026-09-25 onwards a non-production environment with no list texts
      nobody.
- [ ] **[Pete]** `SMS_SENDER` — deliberately unset for now: the reply number still serves the
      existing process. Until it is set the key is inert (the provider is only wired when key and
      sender are both present): UAT simulates every send, production records every reminder as a
      failure. Setting it is the switchover, and needs the TheSMSWorks webhook item above done
      first so replies reach `POST /webhooks/sms`.

### 4. Bring the data across

- [x] **[Claude]** Ran migrations against the new test database (`foodbank-test`) — all 40 applied
      cleanly, `referrals`/`stock_ledger`/`users` verified present.
- [ ] **[Claude]** Production migration (`foodbank`) is still blocked — it needs a genuine, separate
      approval each time (the auto-mode safety classifier treats it as a production action and a
      chat "go ahead" doesn't clear it). **[Pete]** run `npm run db:migrate:production` yourself, or
      change your Bash permission settings if you want me able to run it. Low-stakes either way: the
      new `foodbank` database is still empty, so there's nothing to lose even if it went wrong.
- [x] **[Pete]** Decided: copy the old test system's data across rather than starting clean.
- [x] **[Claude]** Exported the old test database (`wrangler d1 export`, data only), reordered it by
      foreign-key dependency (the export isn't topologically sorted, which fails on D1's remote
      storage — it doesn't support SQL `BEGIN`/deferred-constraint transactions, only Durable
      Objects' own atomic batching in file order), dropped the one row that duplicated a
      migration-seeded default (`stock_take_groupings` "Non-perishable"), and imported the rest.
      Row counts verified to match the export table-by-table.
- [x] **[Claude]** Rebuilt local `wrangler dev` state the same way, then reset the seeded admin's
      login back to `pete@x.com` for local convenience (the deployed test system keeps its own
      private admin emails instead — see the note in "There are four tiers" above about why
      that row's email must never be the public default on anything reachable over the network).
- [ ] **[Pete]** Confirm there's genuinely nothing on the old _production_ D1 database worth
      carrying over. The table above says it's an empty shell at migration `0006`, but I'd be
      trusting that doc rather than verifying a decision that's yours to make.

### 5. Deploy and verify

- [x] UAT is deployed and reachable at `https://api-test.guildfordfoodbank.workers.dev`.

### 6. Cutover — does not apply

**This section assumed a full migration away from the personal account, ending in tearing it down.
That is no longer the plan.** UAT is additive: the personal-account test system
(`foodbank-server`/`foodbank-client`) stays a permanent, separate tier, not something to be repointed
or torn down. Nothing outside this repo needs redirecting, and the old account's Worker and databases
are not going away.

Not part of this migration at all: the domain (needed later for the same-site cookie and Google
OAuth verification, see below) and the Google OAuth client for the spreadsheet extract — neither is
a Cloudflare account resource, so neither needs touching just because the Cloudflare account
changed.

## The refresh cookie requires the frontend to be same-site

`auth.routes.ts` sets the refresh cookie `SameSite=Strict`. Browsers decide "same site" from the
**Public Suffix List**, and both `workers.dev` and `pages.dev` are on it — so `app.pages.dev` and
`api-test.guildfordfoodbank.workers.dev` are as unrelated to a browser as two different companies. The cookie
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
   tokens. **Already set** (2026-09-21, on the charity's own account), which is also what brought the
   empty `api` Worker into existence — `wrangler secret put` creates the Worker if it is absent.
   Rotate it rather than assume it needs creating.
2. Create a Turnstile widget, then `wrangler secret put TURNSTILE_SECRET_KEY --env production`.
3. Set `ALLOWED_ORIGINS` if the frontend is on a different origin. **Never a wildcard** — this API
   sends a refresh cookie, and `*` cannot carry credentials, so the "fix" would be reflecting
   whatever `Origin` arrives, which is no policy at all. Empty means same-origin only, which is
   correct if the frontend ships as Workers static assets.
4. Implement Google auth. `AUTH_MODE=google` currently means "no way to log in".
5. Set `PII_RETENTION_DAYS=456` — the period is settled; see below.
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

   **Local dev has a third spreadsheet, layered on top of the test one via `.dev.vars`.** The
   top-level `GOOGLE_SHEETS_SPREADSHEET_ID` in `wrangler.jsonc` is what the deployed test system
   (`api-test.guildfordfoodbank.workers.dev`) uses; `wrangler dev` reads the same file, so without an override
   a local run would write into the deployed test system's rows. `.dev.vars` wins over `vars` for
   local `wrangler dev` only (confirmed 2026-09-14), so `GOOGLE_SHEETS_SPREADSHEET_ID` set there
   gives local dev its own spreadsheet without touching the deployed test value. See
   `.dev.vars.example`.

   Two things to be deliberate about before turning it on, both the charity's to weigh and neither
   enforceable from here: **residency** — a Workspace with EU data regions keeps the residency the
   D1 jurisdiction was chosen for, a personal Gmail account does not — and the fact that **the
   fifteen-month purge cannot reach the spreadsheet**. See
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

The period is **fifteen months**, settled by the charity on 2026-08-06 at twelve months and revised
to fifteen on 2026-09-09 (`INITIAL_SPEC1.txt`, `#Forgetting a referral`). `PII_RETENTION_DAYS` is
nonetheless still **unset**, so the purge runs nightly and purges nothing. Setting it to `456` is
the whole change — and it is the moment the system starts deleting personal data, which is why it is
a deliberate step at go-live rather than something already done.

Fifteen months is also the lookback the repeat-referral count on the review screen depends on. Do not
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
| **CPU per invocation**         | **10 ms** | 30 s          | **Reliably exceeded by the nightly job, but confirmed harmless.** Applies to cron invocations too. D1 wait does not count, so most routes are safe. See below.             |
| D1 queries per invocation      | 50        | 1,000         | Already designed around — see the query-budget note in `materialise-sessions.ts`. The PII purge is the known violator and stays inert while `PII_RETENTION_DAYS` is unset. |
| Requests per day               | 100,000   | —             | No.                                                                                                                                                                        |
| Cron triggers per account      | 5         | —             | No — one trigger, as the config comment says.                                                                                                                              |
| D1 databases / storage         | 10 / 5 GB | 50,000 / 1 TB | No.                                                                                                                                                                        |

**These limits are per _account_, not per Worker.** On the old personal account this mattered because
it also ran an unrelated Worker, `losttemple-api`, sharing the same 100,000 daily requests, D1
budgets and five cron triggers — **exceeding the daily request cap returns error 1027 for every
Worker on the account**, so a bot hammering the public referral form could have taken the other
Worker down with it. That coupling is exactly why the account migration below moved to a dedicated
account: the charity's account runs nothing else, so this account-wide sharing risk no longer
applies here. The limits themselves are unchanged, though — still worth the paid plan before the
referral form is advertised widely.

Do **not** rename the `workers.dev` subdomain to something food-bank-ish. It is account-wide and
would change the other Worker's URL too. Get a domain instead.

**Rate limiting works on the free plan** — verified against the deployed test system: 60 sequential
posts to `POST /public/referrals` (limit 5/60s) returned 43 × `429`. But it is **permissive and
eventually consistent by design**, and Cloudflare says so: a short or heavily parallel burst gets
through before the counter propagates. 12 rapid posts against the same 5/60s limiter produced no
`429` at all. Treat it as protection against sustained abuse, not as an exact gate — and never write
a test that asserts the Nth request is refused.

**The 10 ms CPU ceiling is reliably exceeded by the nightly job, and that is expected, not a bug.**
Confirmed 2026-09-13 by profiling the real job — against a database with real recurring
templates, not an empty one — both via the admin trigger route and via repeated calls to the local
scheduled-handler test endpoint: the _first_ call to this job's code in a given isolate costs 8–10×
more than every call after it, because `materialiseSessions`, the purges and the timezone
conversion inside them are only ever called by this one job. Nothing else in the app exercises that
code, so it never gets promoted out of V8's slow interpreter tier before the isolate is likely
evicted again. It is not about being cron specifically — an HTTP-triggered run of the identical code
showed the same elevated cost — and it is not about data volume; the job's actual work (a handful of
D1 reads/writes and two subrequests) is close to free once warm. There is no Cloudflare feature to
keep a specific isolate or function warm, and a second warming cron would only relocate the same
cold-first-call cost onto a different invocation, so this is not actionable and not worth chasing.
It does not matter operationally either way: processing time is reference-only and does not feed the
alert (`INITIAL_SPEC1.txt`, `#Platform usage monitoring`), and every invocation observed so far —
cold or warm — has returned `outcome: "ok"`.

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
