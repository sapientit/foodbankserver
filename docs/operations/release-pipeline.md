# The emergency release route: the server's side

The project directory (`sapientit/foodbank`) holds a deploy command for **emergency fixes**: one
person, on a prepared machine, pushes the client and the server together and deploys exactly the
pair that was pushed and tested. **`deploy-spec.md` in that repository is the source of truth for
what the deploy does**; its commands live there, not here. This file is the server's half: what the
server provides to those commands and what they must know about it.

**This route is additional, not a replacement.** Pete's own route — `npm run deploy:test`,
`deploy:uat`, `deploy` and `~/bin/foodbank-deploy-server` — stays as it is for primary development,
and nothing here may change or block it.

## Environments

| Environment | Wrangler `--env` | Account         | Worker            | URL                                              |
| ----------- | ---------------- | --------------- | ----------------- | ------------------------------------------------ |
| test        | `""` (top level) | Pete's personal | `foodbank-server` | `https://foodbank-server.losttemple.workers.dev` |
| UAT         | `uat`            | The charity's   | `api-test`        | `https://api-test.guildfordfoodbank.workers.dev` |

- **test** is Pete's personal Cloudflare account, reached through his own `wrangler login`. It is
  there so Pete can try the route on his own; nobody else has access, and it stops being relevant
  after go-live.
- **UAT** is reached with the charity's API token. Set **both** `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` — with the token alone, `wrangler d1` can resolve to a cached personal
  login instead (see [`production.md`](./production.md)).
- **Production is not on this route yet.** Before it can be, its first migration has to be run by
  hand and its `AUTH_MODE` set to `google` — the Worker refuses to start in production otherwise.
- Both databases are named `foodbank-test` (on different accounts). The `--env` decides which.

## Every server setting is already in `wrangler.jsonc`

Sign-in mode, the Google client, the bot-check hostnames, the spreadsheet — everything that differs
between environments is in that environment's block of `wrangler.jsonc`, in the commit being
deployed. **The deploy command passes no server settings.** Secrets are already held by each
deployed Worker and survive a deploy; the command neither sets nor checks them.

## Preparation: build while the person is there

From `foodbankserver`, checked out at the tested commit:

```bash
npm ci
npm run build:<test|uat>
```

`build:<env>` refuses an uncommitted working tree, writes the Worker exactly as it will be uploaded
to `dist/<env>/worker.js`, and records the commit it was built from in `dist/<env>/COMMIT`.

What the preparation also needs from the server:

| Need                        | Command (run from `foodbankserver`)                                      |
| --------------------------- | ------------------------------------------------------------------------ |
| Pending migrations, by name | `npx wrangler d1 migrations list foodbank-test --remote --env <""\|uat>` |
| Time Travel is readable     | `npx wrangler d1 time-travel info foodbank-test --env <""\|uat> --json`  |

## The deploy itself: from that build

```bash
npx wrangler d1 time-travel info foodbank-test --env <""|uat> --json   # only if migrations are pending; keep the bookmark
npm run db:migrate:<test|uat>
npm run deploy:<test|uat>:built
```

- **`deploy:<env>:built` uploads `dist/<env>/worker.js` without rebuilding** — byte for byte what
  the build wrote — and stamps `dist/<env>/COMMIT` as the deployed version. It refuses if the working
  tree is not clean or the checkout is no longer the commit that was built.
- **Migrations are not in the build.** `db:migrate:<env>` applies `migrations/` from the checkout,
  which is why the checkout must stay at the built commit until the deploy has run. When nobody is
  at the keyboard, Wrangler skips its confirmation prompt and still takes its own backup.
- **Migrate before deploying.** A new server may read a column only the migration creates.
  So far every migration has left the previous server working on the new schema, which is what
  makes the gap between the two steps safe; a migration that does not should say so in its header.

## Verifying

Both routes are at the root, not under `/api/v1`:

- `GET /health` → `{"status":"ok","version":"<commit>"}`. **`version` must equal
  `dist/<env>/COMMIT`.** Just after a deploy the old version can answer for a few seconds, so retry.
- `GET /ready` → `200` with `{"status":"ok","checks":{"database":"ok"}}` once D1 answers; `503`
  otherwise.

## Putting it back

The command never does these itself; the failure email gives them to a person.

```bash
npx wrangler d1 time-travel info foodbank-test --env <""|uat> --json                    # fresh bookmark first
npx wrangler rollback --env <""|uat>                                                       # previous server version
npx wrangler d1 time-travel restore foodbank-test --env <""|uat> --bookmark <deploy's bookmark>
```

Then confirm `referrals`, `stock_ledger` and `users` exist and `/ready` answers `200`.

## The nightly job

Both environments run the server's scheduled job at **02:17 UTC** (`17 2 * * *`) — **03:17 London
time while British Summer Time is in force**. Cloudflare schedules in UTC; a Mac schedules in local
time. It creates the coming weeks' sessions, deletes old text messages and, once a retention period
is set, purges personal data; each job writes in a single batch.

The emergency route's overnight deploy runs at **04:17 London time** by default, clear of the job in
both seasons. An overlap would do no great harm — each job's writes are a single batch, so a deploy
cannot catch one half-done.
