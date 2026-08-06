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
- **The stock ledger holds one period only.** Never `UPDATE` a ledger row; the level is
  `SUM(quantity_delta)`. There are exactly **two** deletes and no others: a stock take deletes the
  counted item's rows and writes it a fresh `opening_balance`, and taking an attendance outcome back
  deletes that parcel's rows. **It used to be append-only** — the charity does not want history from
  before the previous take, so the rule changed deliberately. Do not restore it from an old comment,
  and do not add a third delete.
- **Session materialisation never `UPDATE`s an existing session row** — that is what makes an
  admin's re-timed or cancelled occurrence safe by construction.

## Limits

- **100 bound parameters per statement.** Never build a multi-row `INSERT ... VALUES` — it blows the
  limit at ~14 rows. Bind rows as one JSON parameter and expand with `json_each`.
- Drizzle's `db.batch()` **only accepts Drizzle query builders**; a raw `db.run(sql)` fails at
  runtime with `Cannot read properties of undefined (reading 'bind')`. Bulk inserts therefore use
  raw D1 statements via `db.$client.batch()`, confined to **`pick-lists.repository.ts` and
  `stock.repository.ts`** — the pick list writes a parcel line per household, the stock take writes
  a baseline per counted item, and both exceed 100 parameters. Those two files only; a third needs
  the same justification, not a preference.
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
