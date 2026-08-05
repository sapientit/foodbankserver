---
paths:
  - 'migrations/**'
  - 'src/db/**'
  - 'src/modules/**/*.repository.ts'
---

# Database rules

Full reasoning and the history behind each rule: [`docs/engineering/d1-constraints.md`](../../docs/engineering/d1-constraints.md).

## Writing

- **No interactive transactions.** `BEGIN` is an error on D1. `db.batch()` is the only atomicity
  primitive. **You cannot read, decide in TypeScript, then write, atomically.**
- For a multi-write operation the repository exposes a **statement builder** returning an array of
  statements; the service composes them and runs **exactly one** `db.batch([...])`. A repository
  method that writes then reads its own write is impossible — restructure so every value is known
  before the batch is composed.
- Where an invariant needs atomicity, enforce it with **a single conditional statement or a unique
  index** and have the service check the result (`updateLeavingAnotherAdmin` is the pattern).
- **The stock ledger is append-only.** Never `UPDATE` or `DELETE` a ledger row. The level is
  `SUM(quantity_delta)`; a stock take writes an adjustment for the variance.
- **Session materialisation never `UPDATE`s an existing session row** — that is what makes an
  admin's re-timed or cancelled occurrence safe by construction.

## Limits

- **100 bound parameters per statement.** Never build a multi-row `INSERT ... VALUES` — it blows the
  limit at ~14 rows. Bind rows as one JSON parameter and expand with `json_each`.
- Drizzle's `db.batch()` **only accepts Drizzle query builders**; a raw `db.run(sql)` fails at
  runtime with `Cannot read properties of undefined (reading 'bind')`. Bulk inserts therefore use
  raw D1 statements via `db.$client.batch()`, confined to `pick-lists.repository.ts`.
- **50 queries per invocation on the free plan.** No N+1, ever: load reference data once and
  evaluate in memory.
- 100 columns per table.

## Migrations

- **No `ALTER COLUMN`, no `DROP CONSTRAINT`.** Changing a column type or a `CHECK` means a full
  table rebuild.
- **Every PII column is nullable in SQL and required in Zod.** Write `NOT NULL` on a PII column and
  it can never be purged.
- **Dropping a column is usually _not_ a rebuild.** SQLite refuses `DROP COLUMN` only for a column
  named in an index, a `CHECK`, a `FOREIGN KEY`, a generated column or the primary key.
- **drizzle-kit will generate a drop-and-recreate anyway**, justified with "the table is empty" —
  true of a fresh database and the test run and nothing else. On a foreign-key parent that is the
  difference between a migration and data loss. **Read `migrations/0008` before accepting a
  generated rebuild**; it is the worked example, including the two traps (`PRAGMA foreign_keys=OFF`
  is a silent no-op on D1, and the deferred-FK counter only decrements on inserts into the parent).
- Enums are `CHECK` constraints. Do **not** enumerate extra values speculatively — see the doc.

## Error handling — both traps fail silently

- **The constraint name is not on the thrown error, and SQLite names columns, not indexes.** Match
  with `isUniqueViolation(error, 'table.column', …)` and name **every** column of a composite index.
  Matching an index name never fires, and for the stock ledger that would mean stock moving twice.
- **Drizzle's error message contains the bound parameters — that is, the row.** Never log a raw
  database error; always go through `toSafeError`, and never put a raw `error.message` in a
  response. See [`.claude/rules/pii-security.md`](./pii-security.md).

Use `expectOne` / `expectAtMostOne` from `db/expect.ts` rather than `rows[0]!`.
