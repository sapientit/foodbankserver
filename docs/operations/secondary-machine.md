# On the secondary machine

You are reading this because `secondary.local` exists at the root of this repository: this is the
charity's secondary machine, set up by the project directory's `bootstrap.md` for emergency fixes.

**First read `../secondary.md`** — the rules shared with the client, on pulling, pushing and
deploying. It overrides this repository's `CLAUDE.md` on pushing. What follows is only what is
particular to the server.

- **The server's default branch is `main`**, not the client's `master`.
- **`npm run check` is the server's full check.** The push command runs it; running it yourself
  before reporting work done is still expected, as everywhere in this repository.
- **Never run the deployed-system scripts** — `deploy`, `deploy:test`, `deploy:uat`,
  `deploy:<env>:built`, `build:<env>` or any `db:migrate:` other than `db:migrate:local` — nor
  anything in `~/bin`. They belong to Pete's route or to the deploy command, and this machine
  deploys only through the deploy command, run by a person.
- **The local database is restored from the project's seed**:
  `npm run db:restore:local -- ../seed/uat.sql`, with `npm run dev` stopped. Sign in locally as
  `pete@x.com`.
