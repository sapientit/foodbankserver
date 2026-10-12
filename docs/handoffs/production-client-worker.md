# Handoff to the client repository: the production frontend Worker

Written 2026-10-11 by the server repository, for `foodbankclient`. The server cannot see or edit
that repository, so this file carries what it needs. Copy it across. `API.md` and `openapi.yaml`
remain the contract; nothing here changes an API shape.

**Update 2026-10-12:** part 2 is done. The friendly name is `referrals.guildfordfoodbank.org`, both
addresses are on the Google client and the Turnstile widget, and `api` accepts tokens from both.

## What exists on the server side

Production part 1 is done (see `docs/operations/production.md`, "Standing production up").

|                        | Production                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| Cloudflare account     | the charity's, `deb0c45ee0e89fad81d6b1227d7c439a` (same as UAT)         |
| Server Worker          | `api`, at `https://api.guildfordfoodbank.workers.dev`                   |
| Deployed commit        | `5d037aa` (check `/health`'s `version`)                                 |
| Auth                   | `AUTH_MODE=google`. There is no dummy sign-in and no `dev-login`        |
| Data                   | UAT's configuration only: no referrals, sessions or stock history       |
| Published form release | `98c20e85-d2c1-406f-ad26-c763e47942cc`, the same release UAT has in use |

## What the client needs to build

A production frontend Worker named **`referrals`** on the charity account. It mirrors the existing
`uat` environment (`referrals-test` → `api-test`), but points at `api`.

1. **A `production` environment in `wrangler.jsonc`**, shaped like `env.uat`:
   - `"name": "referrals"`
   - the same `assets` block as UAT (SPA not-found handling, worker-first for `/api/*` and
     `/client-version.json`)
   - `"services": [{ "binding": "API", "service": "api" }]`
2. **Build-time values for production:**

   | Variable                  | Value                                                                                        |
   | ------------------------- | -------------------------------------------------------------------------------------------- |
   | `VITE_TURNSTILE_SITE_KEY` | `0x4AAAAAAFT8AhS7mvcP_1W-` (widget `referrals`, new; not UAT's)                              |
   | `VITE_AUTH_MODE`          | `google`                                                                                     |
   | `VITE_GOOGLE_CLIENT_ID`   | `746866667590-us7ee47uheispedj0qtonpum27rpa2i4.apps.googleusercontent.com` (shared with UAT) |

3. **A production deploy path** in `deploy-foodbank-client` / `deploy_foodbank`. It authenticates
   with the charity-account token from Keychain (`foodbank-charity-cloudflare-api-token`) **and**
   pins `CLOUDFLARE_ACCOUNT_ID=deb0c45ee0e89fad81d6b1227d7c439a`. With the token alone, this machine's
   cached personal-account login wins for some subcommands, and a stray `api` Worker was once created
   on the wrong account that way. The production server deploy refuses a commit that isn't pushed;
   the client deploy should do the same, so `client-version.json` names a findable commit.

The proxy requirements in `API.md` ("What the proxy must get right") apply unchanged. Three matter
most in production:

- **Forward the original `Request`**, so `cf-connecting-ip` reaches the rate limiter and Turnstile.
- **Proxy path for path**, so the refresh cookie's `/api/v1/auth` scope matches.
- **Return `Set-Cookie` intact.**

## What waits on the charity (part 2)

The friendly `guildfordfoodbank.org` name for this Worker has **not been chosen**. Do not guess it.
When it is chosen:

- The charity adds it as a custom domain on `referrals`.
- The server adds it to the `referrals` Turnstile widget and to `TURNSTILE_HOSTNAMES`, then redeploys
  `api`. Until then a Turnstile token solved on that name is refused.
- **The charity adds both addresses** (`https://referrals.guildfordfoodbank.workers.dev` and the
  friendly name) to the Google client's Authorised JavaScript origins.

## What can and cannot be tested before then

- **Without sign-in:** the Worker serves the app, `/client-version.json`, and the proxy to `api` (for
  example `GET /api/v1/public/questionnaire` through the client returns release `98c20e85…`). The
  public referral form's Turnstile works on the workers.dev address.
- **Not until part 2:** anything that needs a person signed in. Google sign-in fails closed until the
  origins are added, which is expected and not a client fault.
- **Do not submit test referrals to production.** It is the charity's real system, SMS is live in
  production by design, and there is no dummy mode to make a test referral harmless.
