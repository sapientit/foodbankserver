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

The database must be created with the EU jurisdiction, because it holds UK personal data. **This
cannot be changed afterwards.**

```bash
npx wrangler d1 create foodbank --jurisdiction=eu
```

Paste the returned `database_id` into both places in `wrangler.jsonc`, then:

```bash
npm run cf-typegen
npm run db:migrate:remote
```

## Scripts

| Command                    | Description                                             |
| -------------------------- | ------------------------------------------------------- |
| `npm run dev`              | Run locally with wrangler                               |
| `npm run check`            | Typegen, typecheck, lint, format, tests, deploy dry-run |
| `npm test`                 | Run the test suite inside workerd                       |
| `npm run db:generate`      | Generate a migration from the Drizzle schema            |
| `npm run db:migrate:local` | Apply migrations to the local D1                        |
| `npm run deploy`           | Deploy the production environment                       |

Run `npm run check` before committing. CI runs the same command on every push and pull request
(`.github/workflows/check.yml`), so a missed local run is caught rather than merged.

## Configuration

All configuration comes from Worker bindings and is validated at startup by `src/config/env.ts`.
See `wrangler.jsonc` for the declared vars.

The server **refuses to start** with `AUTH_MODE=dummy` while `ENVIRONMENT=production`.

## Status

Early scaffold. The platform is in place — Hono, D1, Drizzle, tests in workerd — but there is no
authentication and no domain functionality yet. See the "Current state" section of `CLAUDE.md`.
