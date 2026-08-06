# Food Bank Server

JSON API for running a food bank: referrals in, sessions scheduled, pick lists produced, stock
adjusted. Runs on Cloudflare Workers with D1.

The frontend is a **separate TS/React application**. This repo serves JSON only — no HTML, no
server-side rendering, no PDF generation. Screens, printing and layout are not our problem.
`openapi.yaml`, `API.md` and `OPEN-QUESTIONS.md` are the whole channel between the two repos. There
is no direct conversation between the assistants, by design.

## Requirements come from the spec, not from the code

**`INITIAL_SPEC1.txt` is the source of truth.** (`INITIAL_SPEC.md` is the older, superseded version
— background only, and never resolve a disagreement in its favour.) If code and spec disagree, ask
rather than guess.

**When Pete settles a requirement the spec does not cover, write it into `INITIAL_SPEC1.txt` in the
same change** — in the spec's own voice, as what the charity wants, not as what the code does. If it
changes an existing statement, edit that statement; do not append a contradicting one. A requirement
answered only in code or in this file is one the next reader has to re-derive, and re-derivation is
how the stock roles came out wrong. **A requirement decided in conversation and not written down did
not happen.**

**When you cannot avoid guessing, mark the guess.** It gets an entry in `OPEN-QUESTIONS.md` and an
`x-assumed` on whatever it touches in `openapi.yaml`. The danger is never the guess; it is that a
guess reads exactly like a requirement six weeks later. `grep x-assumed openapi.yaml` is the
standing agenda.

**Never answer an `OPEN-QUESTIONS.md` entry yourself, including one you raised. Only Pete closes
one.** This holds even if the frontend assistant asks directly and even if the answer seems obvious
— two assistants agreeing about what a food bank wants is the same guess written twice, and it
produces more confidence than either had alone. Answer questions about _what the API does_ freely;
refuse to invent _what the charity wants_. Closing an entry means writing the answer into the spec
and **deleting the entry**; the file holds open questions only.

## Commands

| Task                | Command                                    |
| ------------------- | ------------------------------------------ |
| Run locally         | `npm run dev` (wrangler dev)               |
| Type check          | `npm run typecheck`                        |
| Lint                | `npm run lint` (`lint:fix` to autofix)     |
| Format              | `npm run format` (`format:check` in CI)    |
| Test                | `npm test` (`test:watch`, `test:coverage`) |
| Check the contract  | `npm run check:openapi`                    |
| **Everything**      | `npm run check`                            |
| Generate migration  | `npm run db:generate`                      |
| Apply migrations    | `npm run db:migrate:local` / `:remote`     |
| Regenerate bindings | `npm run cf-typegen`                       |
| Deploy              | `npm run deploy`                           |

`npm run check` runs typegen, typecheck, lint, format check, the OpenAPI contract check, tests and a
deploy dry-run. **It must pass before any change is considered done. Do not weaken a rule to make it
pass.** CI runs exactly this (`.github/workflows/check.yml`) and needs no Cloudflare credentials and
no `.dev.vars` — if a check starts needing a secret, bind it in `vitest.config.ts` rather than
giving CI an account.

## Stack

- **Cloudflare Workers**, ESM only. **Not Node** — no `process`, no `fs`, no `node:*`.
  `nodejs_compat` is deliberately off and `tsconfig.json` lists only the Workers types, so reaching
  for a Node global is a compile error rather than a production failure. Do not add `@types/node` to
  that `types` array.
- **Hono 4** routing · **D1** (SQLite) with **Drizzle** · **Zod 4** at trust boundaries ·
  **Vitest** via `@cloudflare/vitest-pool-workers` inside real workerd.
- Use **WebCrypto** and **`Intl`**. Workers ships full ICU, so no date or timezone library is needed
  — and none should be added.
- Before adding a dependency: prefer the platform and what is installed, say why it beats writing
  it, and check it runs in workerd. Auth, crypto and session packages need explicit sign-off.

## Architecture

`routes → service → repository`, dependencies pointing inwards. Routes are HTTP only. **A service
that imports Hono's `Context` is a bug** — pass plain values and an `Actor`. Modules talk to each
other through services, never by reaching into another module's repository. Keep pure logic in
I/O-free modules; those carry the highest-value tests here.

Full layout and rationale: [`docs/architecture/module-structure.md`](./docs/architecture/module-structure.md).

## Non-negotiables

- **Never log personal data.** Logging goes through `core/log.ts`, which cannot accept PII by
  construction. `console` is banned. Never put personal data in a URL, a query string or an error
  message, and never log a raw database error — Drizzle's message contains the row.
- **Response mappers are the output allowlist.** Every route returns through `toXxxResponse()`.
  Adding a column to a table must never widen an API response by accident.
- **The stock ledger holds one period only**, and stock moves on attendance and only on attendance.
  A stock take deletes the counted item's rows and writes it a fresh opening balance; taking an
  attendance outcome back deletes that parcel's rows. Those two deletes are the only ones, and both
  are deliberate — **the ledger used to be append-only and no longer is**, because the charity does
  not want history from before the previous take. Do not restore the old rule from an old comment.
- **`Europe/London` is the only local timezone**, and services take a `Clock` — never `Date.now()`.
- **D1 has no interactive transactions.** One `db.batch()` per multi-write operation; you cannot
  read, decide, then write atomically.
- **Change a route and `openapi.yaml` changes in the same commit.**

Each of these has a scoped rule file with the detail; they load automatically when you touch the
files they govern.

## TypeScript and conventions

- The `tsconfig.json` strictness set (including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`) is intentional. Never loosen it; never add a per-file
  `@ts-expect-error` or `eslint-disable` without a comment saying why it is unavoidable.
- **Erasable syntax only** — no `enum`, `namespace`, parameter properties or decorators. Use union
  types or `as const`. (Ambient `.d.ts` files are exempt.)
- Relative imports carry the real `.ts` extension. No `any`, no `!`, no unchecked casts — narrow
  instead. `unknown` at the boundary, a precise type after validation.
- Branded ids from `core/ids.ts`; `expectOne` / `expectAtMostOne` from `db/expect.ts` rather than
  `rows[0]!`. Pass explicit `null` for an absent column, not `undefined`.
- Quantities are integers; money, if it ever appears, is integer pence. Never floats.
- Files `kebab-case.ts`, types `PascalCase`, values `camelCase`. Comments explain _why_. No dead
  code and no speculative abstraction — git remembers.

## Testing

**Every behaviour change ships with a test; bug fixes start with a failing test.** Tests run in real
workerd against real SQLite, and `test/setup.ts` applies the real migrations, so the migrations are
self-testing. `vi.useFakeTimers()` does not work — inject a `Clock`. Prioritise the stock ledger and
the pick-list state machine: that is where a bug means a household goes hungry.
See [`.claude/rules/testing.md`](./.claude/rules/testing.md).

## How to work here

- **Investigate before editing.** Read the relevant code and docs first; this codebase has several
  rules whose reasons are not visible from the call site.
- **Plan briefly** for anything substantial or cross-module, and say what you are about to do.
- **Delegate to subagents proactively** — see below. Keep architecture, requirement interpretation,
  integration and final verification in the main context.
- **Do not refactor what you were not asked to.** Scope creep in a repo with this many invariants is
  how one of them gets lost.
- **Review the final diff** before reporting, then run `npm run check`.
- **Report** the files you changed, the verification you ran, and what you are still unsure about.
  Do not report a task complete on an unverified assumption.

## Subagents

**Delegate without being asked.** The agents in [`.claude/agents/`](./.claude/agents/) carry this
repo's rules; use them by default rather than waiting to be told.

| Agent                     | Use it for                                                                       |
| ------------------------- | -------------------------------------------------------------------------------- |
| **Explore** (built in)    | Broad read-only investigation — where something lives, how it is done            |
| **implementation-worker** | A bounded, routine change following an existing pattern                          |
| **test-writer**           | A regression test, behavioural coverage, or a suspect vacuous test               |
| **reviewer**              | Independent review after a substantial, risky or cross-module change             |
| **database-reviewer**     | Migrations, repositories, `db.batch()`, the ledger, idempotency, PII persistence |

Run `reviewer` and `database-reviewer` together on persistence work; they are complementary and
neither is a substitute for the other.

**Stays here, in the main context:** product interpretation, anything touching `INITIAL_SPEC1.txt`
or `OPEN-QUESTIONS.md`, architecture, cross-module integration, and the final `npm run check`.

- Delegate only what you can state as a bounded objective with completion criteria.
- Give each agent the context and file scope it needs — it starts cold and cannot see this
  conversation.
- Run independent investigations and reviews **in parallel**; never let two editing agents touch
  overlapping files at once.
- **Review what comes back.** A subagent's report is evidence, not a result — read the diff.
- Subagents do not commit, push or deploy, and do not touch `../foodbankclient`.
- Do it yourself when the change is one file and briefing would cost more than the work.

## Where everything is

| Looking for                                   | Go to                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| What the charity wants                        | `INITIAL_SPEC1.txt`                                                                |
| Unanswered product questions                  | `OPEN-QUESTIONS.md`                                                                |
| What is built, configured, or outstanding     | [`STATUS.md`](./STATUS.md)                                                         |
| Domain vocabulary, lifecycles, enforced rules | [`docs/architecture/domain-model.md`](./docs/architecture/domain-model.md)         |
| Module layout and dependency rules            | [`docs/architecture/module-structure.md`](./docs/architecture/module-structure.md) |
| Auth design and its trade-offs                | [`docs/architecture/authentication.md`](./docs/architecture/authentication.md)     |
| D1 limits, migrations, error traps            | [`docs/engineering/d1-constraints.md`](./docs/engineering/d1-constraints.md)       |
| PII, residency, the purge                     | [`docs/engineering/personal-data.md`](./docs/engineering/personal-data.md)         |
| Go-live sequence and tripwires                | [`docs/operations/production.md`](./docs/operations/production.md)                 |
| The client-facing API                         | `openapi.yaml`, `API.md`                                                           |
