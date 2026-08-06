# Going to production

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
   tokens.
2. Create a Turnstile widget, then `wrangler secret put TURNSTILE_SECRET_KEY --env production`.
3. Set `ALLOWED_ORIGINS` if the frontend is on a different origin. **Never a wildcard** — this API
   sends a refresh cookie, and `*` cannot carry credentials, so the "fix" would be reflecting
   whatever `Origin` arrives, which is no policy at all. Empty means same-origin only, which is
   correct if the frontend ships as Workers static assets.
4. Implement Google auth. `AUTH_MODE=google` currently means "no way to log in".
5. Set `PII_RETENTION_DAYS=365` — the period is settled; see below.

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

## Backups

**Time Travel is the backup** — 30 days on paid, whole-database restore only. You cannot restore one
table. Plan any destructive migration on the basis that the rollback is "restore everything to a
point in time".

## Scheduled work

One cron trigger, `17 2 * * *`, runs everything: session materialisation (six weeks ahead), expiry
of referral edit keys, and the PII purge. One trigger rather than three because the free plan allows
only five per account and there is no reason to spend more.

`runScheduledJobs` is shared by the cron handler and the admin trigger route, so the thing that runs
unattended at 02:17 is exactly the thing exercised by hand and by tests — not a parallel
implementation of it. It is idempotent: a second run creates nothing.

## First-time database creation

The database must be created with the EU jurisdiction, because it holds UK personal data, and
**this cannot be changed afterwards**:

```bash
npx wrangler d1 create foodbank --jurisdiction=eu
```

See `README.md` for the rest of the first-run setup.
