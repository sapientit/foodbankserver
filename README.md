# Food Bank Server

JSON API for managing a food bank: referrals, sessions, pick lists and stock. Runs on Cloudflare
Workers with D1.

The frontend is a separate TS/React application — this repo serves JSON only.

See [`INITIAL_SPEC1.txt`](./INITIAL_SPEC1.txt) for requirements, [`CLAUDE.md`](./CLAUDE.md) for the
working rules, [`STATUS.md`](./STATUS.md) for what is built and what is outstanding, and
[`docs/`](./docs) for architecture, engineering and operations detail.

## Requirements

- Node.js 26 or later (tooling only — the server itself runs on the Workers runtime)
- A Cloudflare account

## Getting started

```bash
npm install
npm run db:migrate:local
npm run dev
```

Then:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/ready
```

## First-time Cloudflare setup

There are three deployments and **three separate databases** — `foodbank-test` on the personal
account for the live test system, `foodbank-test` on the charity's own account for UAT, and
`foodbank` for production — so no deployment can write into another's data. All are created with the
EU jurisdiction, because they hold UK personal data. **This cannot be changed afterwards.**

```bash
npx wrangler d1 create foodbank-test --jurisdiction=eu
```

Paste the returned `database_id` into the **top-level** `d1_databases` block in `wrangler.jsonc`
(UAT's lives in `env.uat`, production's in `env.production`, and all three must stay different),
then:

```bash
npm run cf-typegen
npm run db:migrate:test
```

The test system is live at `https://foodbank-server.losttemple.workers.dev`, on the personal
Cloudflare account; UAT is live at `https://api-test.guildfordfoodbank.workers.dev`, on the
charity's own account, and signs in with real Google identities rather than dummy auth. Neither
**must ever hold real personal data**. See
[`docs/operations/production.md`](./docs/operations/production.md) for the deployment table, the
free-plan limits and the go-live sequence.

## Scripts

| Command                         | Description                                                       |
| ------------------------------- | ----------------------------------------------------------------- |
| `npm run dev`                   | Run locally with wrangler                                         |
| `npm run check`                 | Typegen, typecheck, lint, format, tests, deploy dry-run           |
| `npm test`                      | Run the test suite inside workerd                                 |
| `npm run db:generate`           | Generate a migration from the Drizzle schema                      |
| `npm run db:migrate:local`      | Apply migrations to the local D1                                  |
| `npm run db:migrate:test`       | Apply migrations to the remote `foodbank-test` (personal account) |
| `npm run db:migrate:uat`        | Apply migrations to the remote `foodbank-test` (charity account)  |
| `npm run db:migrate:production` | Apply migrations to the remote `foodbank`                         |
| `npm run deploy:test`           | Deploy the test environment (personal account)                    |
| `npm run deploy:uat`            | Deploy the UAT environment (charity account)                      |
| `npm run deploy`                | Deploy the production environment                                 |

Run `npm run check` before committing. CI runs the same command on every push and pull request
(`.github/workflows/check.yml`), so a missed local run is caught rather than merged.

## Configuration

All configuration comes from Worker bindings and is validated at startup by `src/config/env.ts`.
See `wrangler.jsonc` for the declared vars.

The server **refuses to start** with `AUTH_MODE=dummy` while `ENVIRONMENT=production`.

## Status

The domain flow is complete end to end — **referral → session → pick list → attendance → stock** —
along with authentication, staff accounts and roles, the listener sheet, SMS reminders, the fuel
help list, repeat-referral matching and the spreadsheet extract.

A **test system is deployed**; production is not. Several features are written and wired but inert
until a value is set — the PII purge, Turnstile, SMS credentials — and there is still no Google
identity provider, so `AUTH_MODE=google` currently means "no way to log in".

[`STATUS.md`](./STATUS.md) is the authority on all of this: what is built, what is waiting on
configuration, what is agreed but not yet built, and what is deliberately unresolved. Open product
questions live in [`OPEN-QUESTIONS.md`](./OPEN-QUESTIONS.md) and only Pete closes them.
