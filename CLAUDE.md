# Food Bank Server

JSON API for running a food bank: referrals in, sessions scheduled, pick lists produced, stock
adjusted. Runs on Cloudflare Workers with D1.

**`INITIAL_SPEC1.txt` is the source of truth for requirements.** (`INITIAL_SPEC.md` is the older,
superseded version — read it only for background, and never resolve a disagreement in its favour.)
The spec is still being expanded. If code and spec disagree, ask rather than guess.

The frontend is a **separate TS/React application**. This repo serves JSON only — no HTML, no
server-side rendering, no PDF generation. Screens, printing and layout are not our problem.

## Commands

| Task                | Command                                    |
| ------------------- | ------------------------------------------ |
| Run locally         | `npm run dev` (wrangler dev)               |
| Type check          | `npm run typecheck`                        |
| Lint                | `npm run lint` (`lint:fix` to autofix)     |
| Format              | `npm run format` (`format:check` in CI)    |
| Test                | `npm test` (`test:watch`, `test:coverage`) |
| **Everything**      | `npm run check`                            |
| Generate migration  | `npm run db:generate`                      |
| Apply migrations    | `npm run db:migrate:local` / `:remote`     |
| Regenerate bindings | `npm run cf-typegen`                       |
| Deploy              | `npm run deploy`                           |

`npm run check` runs typegen, typecheck, lint, format check, tests and a deploy dry-run. It must
pass before any change is considered done. Do not weaken a rule to make it pass.

**CI runs exactly this** on every push and pull request — `.github/workflows/check.yml`. It needs
no Cloudflare credentials (`wrangler types` reads the config locally, `--dry-run` never calls the
API) and no `.dev.vars` (the test bindings in `vitest.config.ts` supply everything). Keep it that
way: if a check starts needing a secret, the fix is usually to bind it in the test config rather
than to give CI an account.

Rerun `npm run cf-typegen` after changing `wrangler.jsonc` — `check` does it for you, so a stale
`worker-configuration.d.ts` fails review rather than production.

## Stack

- **Cloudflare Workers**, ESM only. **Not Node** — there is no `process`, no `fs`, no `node:*`.
  `nodejs_compat` is deliberately off, and `@types/node` is deliberately absent, so reaching for a
  Node API is a compile error rather than a production failure.
- **Hono 4** for routing.
- **D1** (SQLite) with **Drizzle**, migrations in `migrations/`.
- **Zod 4** for parsing anything crossing a trust boundary.
- **Vitest** via `@cloudflare/vitest-pool-workers`, running inside real workerd.
- Use **WebCrypto** (`crypto.subtle`, `crypto.getRandomValues`, `crypto.randomUUID`) and **`Intl`**.
  Workers ships full ICU, so no date or timezone library is needed — and none should be added.

## D1 limits are design constraints, not trivia

These are not edge cases. Each one has already shaped the design, and ignoring one produces code
that passes tests and fails in production.

**No interactive transactions.** `BEGIN` is an error on D1. `db.batch()` is the only atomicity
primitive: statements commit sequentially and non-concurrently, and any failure rolls back the whole
sequence. **You cannot read, decide in TypeScript, then write, atomically.**

The repository contract that follows from this:

> For a multi-write operation, the repository exposes a **statement builder** returning an array of
> statements. The service composes them and executes **exactly one** `db.batch([...])`. A repository
> method that writes and then reads its own write is impossible — restructure so every value the
> write needs is known before the batch is composed.

Where an invariant genuinely needs atomicity, enforce it with **a single conditional statement or a
unique index**, and have the service check the result. The one that matters most is the stock ledger
idempotency guard — see below.

**100 bound parameters per statement.** Never build a multi-row `INSERT ... VALUES` — it blows the
limit at about 14 rows. Bind the rows as one JSON parameter and expand with `json_each`. That is one
statement and one parameter regardless of row count.

Drizzle has no builder for that, **and its `db.batch()` only accepts Drizzle query builders** — a
raw `db.run(sql)` is not a batchable item and fails at runtime with a confusing
`Cannot read properties of undefined (reading 'bind')`. So bulk inserts use raw D1 prepared
statements through `db.$client.batch()`. That is confined to
`pick-lists.repository.ts` and covered by integration tests; everything else stays in Drizzle.

**100 columns per table.** This is part of why dynamic referral answers are a JSON column rather
than generic spare columns.

**50 queries per Worker invocation on the free plan** (1,000 on paid). We develop against free and
deploy to paid. No N+1, ever: load reference data once and evaluate in memory. The pick-list
generation path has a test that asserts its query count.

**No `ALTER COLUMN`, no `DROP CONSTRAINT`.** Changing a column type or constraint means a full
table rebuild. Two consequences, both deliberate and both easy to "tidy up" by mistake:

- **Every PII column is nullable in SQL and required in Zod.** Requiredness lives in the schema
  module, not the DDL. Write `NOT NULL` on a PII column and it can never be purged.
- **Enums are CHECK constraints enumerated generously**, including values unused today.

**Time Travel is the backup** — 30 days on paid, whole-database restore only. You cannot restore one
table.

## Domain

Use these words in code, tests and API paths. Do not invent synonyms.

- **Session** — a scheduled distribution slot. Standard sessions repeat weekly; individual
  occurrences can be re-timed, cancelled, or added ad hoc.
- **Recurring session** — the template a session is generated from.
- **Referral** — a request to feed a household, made by an authorised organisation or person,
  **without authentication**.
- **Household** — the people a referral feeds. Its size drives parcel contents.
- **Parcel** — one household's food for one session.
- **Pick list** — the set of parcels for a session, generated on first view.
- **Stock item** — a food line held in inventory, with a shelf number.
- **Attendance** — whether a referred household turned up.

### Settled decisions

- **Capacity counts households, not people.** A session of capacity 25 holds 25 referrals, whatever
  their household sizes. The public referral flow refuses a full session; an admin may deliberately
  exceed capacity when moving someone.
- **Sessions are materialised**, not computed. A cron generates real session rows 6 weeks ahead.
  Each is independently editable.
- **Roles are `admin` and `team_lead` only.** Team leads run sessions: pick lists, printing,
  attendance. Admins additionally manage referrers, forms, rules, stock and referral amendments.
- **Reason for referral is a dropdown** from a maintained lookup table, not free text — it exists to
  be reported on. **Only `admin` ever receives it.** Enforce that in the response mapper, not by
  hoping a query forgets to select it.
- **Delivery is a fixed column** (`is_delivery` plus a delivery address), not a dynamic form field,
  because picking and logistics branch on it.
- **Dynamic referral answers are a JSON column** plus a versioned form-definition table. A referral
  captured under form version 1 must stay readable after version 2 is published.
- **Parcel contents are a lookup, not a calculation.** The charity maintains named **model
  parcels** ("Single parcel", "Family parcel") and a **30-cell grid** of every household size —
  1-5 adults by 0-5 children. Each cell holds the **name** of a model parcel, so several household
  sizes share one parcel and editing that parcel updates all of them. Bigger households clamp into
  the corner of the grid. **A referral must have at least one adult**, so every referral maps to a
  real cell.
- **Model parcels and the grid are NOT versioned, and must not become so.** When a pick list is
  generated the contents are **copied** into `parcel_lines`. That copy is the entire immutability
  guarantee: a parcel already picked is unaffected by any later edit, and the next pick list picks
  the change up. A draft/publish lifecycle on top would be ceremony protecting something already
  protected.
- **A parcel records its contents, not which model produced them.** "It was a large package" is not
  information anyone needs once the tins are in the bag.
- **The grid is one row**, saved whole — one write, no half-updated state on a database with no
  transactions. A model parcel's **name is not editable**, because the grid references it; delete
  and recreate, which forces the grid to be revisited.

### Lifecycles

```
Referral:  created → scheduled(session) → moved(session) | cancelled
Pick list: draft → printed → confirmed        (confirmed = picking finished, list locked)
Parcel:    pending → attended | no_show
Session:   planned → confirmed | cancelled
```

### Rules the code must enforce, not merely document

- **Stock moves on attendance, and only on attendance.** Generating or confirming a pick list does
  **not** touch stock. When the team lead records attendance: attended → stock decrements; **no-show
  → no ledger entry at all**, because nothing was ever issued. The parcel is simply unpacked.
- **Recording attendance must be idempotent.** A team lead will double-tap, and the request may be
  retried. This is guarded by a unique index on
  `stock_ledger(parcel_id, stock_item_id, movement_type)`, and the service catches that specific
  violation and treats it as success. Use
  `isUniqueViolation(error, 'stock_ledger.parcel_id', 'stock_ledger.stock_item_id',
'stock_ledger.movement_type')` — see the rules below, which are not what you would guess.
- **The stock ledger is append-only.** Never `UPDATE` or `DELETE` a ledger row. The current level is
  `SUM(quantity_delta)`. A stock take records a _count_ and writes an adjustment row for the
  variance — it never overwrites a level.
- **Session materialisation never `UPDATE`s an existing session row.** That is what makes an admin's
  re-timed or cancelled occurrence safe by construction.
- A referral may not be amended by its edit key after 15 minutes, and **an amend does not extend the
  window**.

## Architecture

```
src/
  worker.ts         entrypoint: default export { fetch, scheduled }
  app.ts            buildApp(): Hono<AppEnv> — no fetch binding, so tests can drive it
  config/env.ts     Zod over Worker bindings; the only place raw bindings are read
  core/             errors, branded ids, clock, log, time, crypto
  db/               client, schema/, expect helpers, unique-violation
  http/             context, error handler, middleware
  modules/<name>/   one folder per domain area
```

A module is structured:

- `*.routes.ts` — HTTP only: parse, authorise, call service, map response. No business rules.
- `*.service.ts` — the domain logic. Knows nothing about HTTP, Hono, `Context`, request or response.
- `*.repository.ts` — the storage interface the service needs, plus its Drizzle implementation.
- `*.schema.ts` — Zod schemas and the types inferred from them.

Dependencies point inwards: routes → service → repository. **A service that imports Hono's `Context`
is a bug** — pass plain values and an `Actor` value object instead. Modules talk to each other
through services, never by reaching into another module's repository.

Keep pure logic in its own I/O-free module (`engine.ts`, `matching.ts`, `materialisation.ts`,
`shelf-sort.ts`). Those are the highest-value tests in the codebase and they only exist if the code
is written to allow them.

## TypeScript rules

- The `tsconfig.json` strictness set (including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`) is intentional. Never loosen it, and never add a per-file
  `@ts-expect-error` or `eslint-disable` without a comment saying why it is unavoidable.
- **Erasable syntax only.** No `enum`, no `namespace`, no parameter properties, no decorators. Use
  union types or `as const` objects. (Ambient `.d.ts` files are exempt — merging into a global
  interface needs `declare namespace`, and nothing there is emitted.)
- Relative imports include the real `.ts` extension (`./foo.ts`).
- No `any`, no non-null assertions (`!`), no unchecked casts. Prefer narrowing and type guards.
  `unknown` at the boundary, a precise type after validation.
- Use branded ids from `core/ids.ts` (`SessionId`, `ReferralId`, …) rather than bare `string`.
- Use `expectOne` / `expectAtMostOne` from `db/expect.ts` for query results rather than `rows[0]!`.
- `exactOptionalPropertyTypes` and Drizzle nullables interact badly — pass an explicit `null` for an
  absent column, not `undefined`.
- Prefer `readonly` fields and returning new values over mutating arguments.
- Quantities are integers. Money, if it ever appears, is integer pence. Never floats.

## Time

- **`Europe/London` is the only local timezone.** Templates and sessions store the wall clock the
  charity typed (`YYYY-MM-DD` + `HH:MM`), plus a derived UTC instant that queries sort and filter on.
  A 10:00 session stays 10:00 across the BST changeover; getting the direction backwards silently
  moves every session by an hour for half the year.
- Conversion lives in `core/time/london.ts` and calendar arithmetic in `core/time/plain-date.ts`.
  Both are pure. Do not do date maths anywhere else, and do not add a date library.
- **Services never call `new Date()` or `Date.now()`** — they take a `Clock` from `core/clock.ts`.
  Fake timers do not work in the Workers test runner, so this is the only way to test expiry.
- **Workers gotcha: `Date.now()` does not advance during a request** until I/O occurs. Two
  consecutive calls return the same value. Never write code that measures elapsed time in a handler.

## Database errors: two traps

Both were found the hard way and both fail **silently**, so read this before writing a guard.

**1. The constraint name is not on the thrown error, and SQLite names columns, not indexes.**
Drizzle wraps D1 failures. `error.message` is `Failed query: insert into …`; the SQLite text is
further down the `cause` chain. And even for a named unique index, SQLite reports
`UNIQUE constraint failed: table.column, table.column`. Matching on an index name never fires —
the guard appears to work and never triggers, which for the stock ledger would mean stock moving
twice. `isUniqueViolation` walks the chain and matches on columns; always name **every** column of
a composite index so it cannot match a different constraint on the same table.

**2. Drizzle's error message contains the bound parameters — that is, the row.** On `referrals`
those are a referee's name, address and phone number. Unhandled errors are logged in full, and
Workers Logs are not EU-pinned, so this is a data-protection failure rather than untidiness.
`toSafeError` redacts everything after `params:`. **Never log a raw database error** — always go
through `toSafeError`, and never put a raw `error.message` into a response.

`test/db-errors.test.ts` pins both behaviours against a real D1 failure rather than a hand-written
`Error`, because assuming the error's shape is exactly what caused the bugs.

## Errors

- Throw the typed errors in `core/errors.ts` (`NotFoundError`, `ConflictError`,
  `UnprocessableError`, …) for anything the client caused. `http/error-handler.ts` maps them to
  status codes and a consistent body.
- Anything else escaping a handler is a bug: logged in full, returned as an opaque 500. Never hand a
  client a stack trace, a SQL string, or an internal message.
- Use `ConflictError` for "wrong state" (pick list already confirmed) and `UnprocessableError` for
  "a rule forbids this" (insufficient stock). The distinction matters to the UI.
- **Never build an error message from personal data.** Error messages are logged, and logs are not
  EU-resident. Put an id in the message, not a name.

## Validation

- Validate at the edge, once, with Zod, then trust the parsed type inwards.
- Never trust a client-supplied id, role, quantity, or status. **Re-derive parcel contents from
  household size on the server** — never accept the contents the client sends.
- Hono has no response-schema mechanism. Every route returns through an explicit
  `toXxxResponse()` mapper with a declared narrow return type. That mapper is the **output
  allowlist** — it is what stops a newly added column leaking to a role that should not see it.
  Adding a field to a database table must never widen an API response by accident.

## Handling personal data

Referrals contain names, addresses, phone numbers, and a reason for needing food. Treat all of it as
sensitive.

**Residency.** The D1 database is pinned to the EU jurisdiction (`--jurisdiction=eu`) and **this
cannot be changed after creation**. But Workers compute runs globally and **Workers Logs are not
EU-pinned**. So "never log PII" is a compliance control here, not merely hygiene. Nothing carrying a
referee's name, address, phone number or reason for referral may leave D1 — not to logs, not to
Analytics Engine, not to any third-party fetch.

- **Logging goes through `core/log.ts`, which cannot accept PII by construction.** `LogContext`
  enumerates the permitted fields and they are all identifiers or counts, so
  `log.info('saved', { referral })` is a compile error. Adding a field to `LogContext` is a
  deliberate decision to be reviewed against this section. `console` is banned everywhere else.
- Never put personal data in a URL path, a query string, or an error message.
- **Return only the fields a role needs.** `reason_id` is admin-only. A pick list needs household
  size, not the reason. This is enforced in response mappers.
- Do not add third-party services that would receive request bodies without asking first.
- Secrets live in Worker secrets, validated in `config/env.ts`. Never commit a `.env`, never
  hardcode a credential, never log one.
- Referral edit keys and refresh tokens are returned to the client once and stored **only as a
  SHA-256 hash**.

## Testing

- Every behaviour change ships with a test. Bug fixes start with a failing test.
- Tests run inside **real workerd against real Miniflare-backed SQLite**, so CHECK constraints,
  partial unique indexes, `batch()` atomicity and `json_each` behave as they will in production.
  `test/setup.ts` applies the real migrations, which makes **the migrations self-testing**.
- Drive HTTP through `buildApp().request(...)`. Use `SELF.fetch()` for the smaller set of tests that
  need genuine end-to-end middleware ordering.
- Unit-test pure modules directly — the rules engine, date maths, shelf sorting, referrer matching.
- Assert on behaviour and public responses, not internal calls. Do not mock what you own.
- Name tests as the rule they enforce: `records stock movements exactly once when attendance is
submitted twice`.
- **Coverage must use `provider: 'istanbul'`** — V8 coverage is unsupported in workerd.
- **`vi.useFakeTimers()` does not work.** Inject a `Clock`.
- **Storage isolation is per test file, not per test.** Reset shared state in `beforeEach`, and
  always `await` every storage operation — unawaited writes leak across the isolation boundary.
- Prioritise the stock ledger and the pick-list state machine. That is where a bug means a household
  goes hungry or the inventory silently drifts.

## Conventions

- Files `kebab-case.ts`; types and classes `PascalCase`; values and functions `camelCase`.
- Routes are plural nouns under `/api/v1`: `/sessions/:sessionId/pick-list`. Verbs go in the method,
  except genuine state transitions, which may be a sub-resource:
  `POST /pick-lists/:id/confirm`.
- Comments explain _why_. Do not narrate what the code already says.
- Keep functions small enough to read without scrolling; extract a named helper rather than adding a
  third level of nesting.
- No dead code, no commented-out blocks, no speculative abstraction for a requirement that has not
  arrived. Git remembers.

## Before adding a dependency

Prefer the platform and what is already installed — WebCrypto and `Intl` cover far more than people
expect, and every dependency has to run inside workerd. If a package is genuinely needed, say what
it is for and why it beats writing it, and check it is maintained and Workers-compatible.
Security-relevant packages (auth, crypto, session handling) need explicit sign-off.

## Authentication

- **Access tokens are stateless HS256 JWTs**, 15 minutes, verified with WebCrypto in
  `modules/auth/token.service.ts` (pure — no database, no HTTP). Verification costs zero queries,
  which is the point: the free plan gives 50 per invocation.
- **Refresh tokens are opaque, rotating and replay-detecting.** Only the SHA-256 hash is stored.
  Every use rotates within a `familyId`; presenting an already-revoked token revokes **the whole
  family**, including the legitimate holder's. That is deliberate — a replay means the token leaked.
- Refresh token travels in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to
  `/api/v1/auth`, so it is never attached to a domain request. The access token goes in the
  response body for the frontend to hold **in memory only**.
- **Swapping in Google means adding one file.** `identity-provider.ts` defines the contract;
  everything downstream of `IdentityClaim` is provider-agnostic. `users.google_subject` already
  exists. Only the dummy provider sets `autoProvisions` — Google must not, because a verified
  Google account proves who someone is, not that this food bank granted them access.
- **The dummy provider has no validation, as specified.** Two structural controls contain it: the
  dev-login route is _not registered_ unless `AUTH_MODE=dummy`, and the Worker refuses to boot with
  `AUTH_MODE=dummy` in production. Any deployment running it is an open admin panel — real referral
  data must never live in one.
- Use `requireAuth` then `requireRole('admin')`. Name roles explicitly per route; do not invent a
  hierarchy where `team_lead` is "a lesser admin".

## Route mounting

**Never use `routes.use('*', requireAuth)` in a sub-app mounted at the shared `/api/v1` prefix.**
A wildcard `use` there applies to every path under the prefix, not just the routes that sub-app
serves. It turns unmatched API paths into 401s instead of 404s, and — the part that actually
matters — would silently require authentication on any public route mounted after it.

Attach middleware per route instead: `routes.get('/sessions', ...readers, handler)`. That also
puts the access level next to the thing it protects. `test/route-mounting.test.ts` guards this.

## Current state

**Slice 0 — platform.** Hono on Workers, D1 wired with the EU jurisdiction, Drizzle, the Workers
Vitest pool with self-testing migrations, health and readiness routes, error handling, and the core
primitives above.

**Slice 1 — auth.** `users` and `refresh_tokens`, dev login, rotation with family replay detection,
`requireAuth` / `requireRole`, `GET /api/v1/auth/me`.

**Slice 2 — sessions.** `recurring_sessions` and `sessions`, the pure occurrence planner, the
materialisation cron (wired to the real `scheduled` handler and to an admin trigger route), admin
CRUD including ad hoc sessions and cancellation, and the unauthenticated 14-day public list.

**Slice 3 — referrers and forms.** `authorised_referrers` with email/domain precedence,
`referral_reasons` (the admin-maintained dropdown), and versioned `form_definitions` /
`form_fields` with a publish flow. Pure matching and answer-validation modules. Public
`GET /public/referral-form` and `POST /public/referrers/check`.

**Slice 4 — referrals.** `referrals` with the PII block, `referral_edit_keys`, `audit_events`.
Unauthenticated submission with authorisation, capacity, reason and answer checks; the 15-minute
self-service edit window; admin amend, cancel and move-with-acknowledgement. The public session
list now excludes full sessions. **Real personal data lives here** — see the PII rules above, and
`test/pii-logging.test.ts`, which asserts against real log output rather than trusting types.

**Slice 5 — stock.** `stock_items` with shelf ordering, the append-only `stock_ledger` with all
three idempotency guards already in place, purchases ("after a shop"), and stock takes that record
a count and write an adjustment for the variance. Autocomplete, and levels derived in one query.

**Slice 6 — model parcels and the household grid.** A flat, freely editable list of
`model_parcels` and a single-row `parcel_grid`, with a preview endpoint. No versioning: see the
settled decisions above.

**Slice 7 — pick lists.** `pick_lists`, `parcels` and `parcel_lines`. Generated on first view in
five reads and one native D1 batch whatever the referral count, editable while draft _and_ after
printing, locked on confirm. Print payload ordered by shelf.

**Slice 8 — attendance.** `POST /parcels/:id/attendance` issues or withholds a parcel, and
`POST /sessions/:sessionId/confirm` closes the session once everyone is ticked off. **This is where
the stock ledger guard does its job** — see the rule above, and `test/attendance.test.ts`, whose
concurrency test is the one that actually proves the index.

The domain flow is now complete end to end: referral → session → pick list → attendance → stock.

**Slice 9 — hardening.** Rate limiting on every unauthenticated route, Turnstile on referral
submission, an allowlist CORS policy, and the PII purge job.

## Going to production

`config/env.ts` **refuses to start** on an unsafe production configuration. Two tripwires:

- `AUTH_MODE=dummy` — an open admin panel over real names and addresses.
- No `TURNSTILE_SECRET_KEY` — an open, unauthenticated write with no bot check.

Both are deliberate. Do not relax them to get a deploy out; fix the configuration.

Before anything holding real data is publicly reachable:

1. `wrangler secret put AUTH_JWT_SECRET --env production`
2. Create a Turnstile widget, then `wrangler secret put TURNSTILE_SECRET_KEY --env production`
3. Set `ALLOWED_ORIGINS` if the frontend is on a different origin. **Never a wildcard** — this API
   sends a refresh cookie, and `*` cannot carry credentials, so the "fix" would be reflecting
   whatever `Origin` arrives, which is no policy at all.
4. Implement Google auth (`AUTH_MODE=google` currently means "no way to log in").

**Rate limiting keys on `cf-connecting-ip`**, which Cloudflare sets and a client cannot spoof.
Never key on `x-forwarded-for`. The binding is optional at runtime so a missing one cannot take the
API down; production safety lives in the config tripwires above, not here.

**Retention is still unresolved.** `PII_RETENTION_DAYS` is unset, so `purgeReferralPii` runs and
purges nothing. That is deliberate: guessing a period and deleting somebody's data on that guess
would be worse than doing nothing. Once the charity decides, set the variable — the job, its tests
and the cron wiring are already in place.

**Not yet built** — tracked so it is not mistaken for finished work:

- No Google identity provider. `AUTH_MODE=google` currently means "no way to log in".
- No admin user management — users are only created by dummy auto-provisioning.
- A pick list reports divergence from its referrals but has no "sync" that adds parcels for
  referrals which arrived afterwards — an admin currently has to handle those manually.
- Attendance can be corrected once in each direction. A third flip is refused, pointing at the
  audited stock-adjustment path, rather than inventing compensating entries that cannot be told
  apart from real ones.
- Model parcels cannot express **exclusions** (no pork, gluten free). Dietary needs are a dynamic
  form field surfaced on the parcel for the picker to substitute manually. Adding exclusions is a
  v2 conversation with the charity, not a gap to be quietly filled in.
- `stripPiiAnswers` exists and is tested but nothing calls it — the purge routine is slice 9, and
  stays unscheduled until the charity sets a retention period.
- **No rate limiting or Turnstile on `POST /public/referrals`**, which is an open, unauthenticated
  write that stores names and addresses. Required before anything is publicly reachable.
- No rate limiting, Turnstile, or CORS policy. The public referral endpoint will need all three.
  **Retention is an unresolved compliance decision.** The schema isolates PII so a purge can be added
  without a table rebuild, but no purge job is scheduled and the charity has not yet set a period.
