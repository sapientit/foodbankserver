# D1 limits are design constraints, not trivia

The mandatory rules are in [`.claude/rules/database.md`](../../.claude/rules/database.md). This file
is why they exist. Each one has already shaped the design, and ignoring one produces code that
passes tests and fails in production.

## No interactive transactions

`BEGIN` is an error on D1. `db.batch()` is the only atomicity primitive: statements commit
sequentially and non-concurrently, and any failure rolls back the whole sequence. **You cannot read,
decide in TypeScript, then write, atomically.**

The repository contract follows directly:

> For a multi-write operation, the repository exposes a **statement builder** returning an array of
> statements. The service composes them and executes **exactly one** `db.batch([...])`. A repository
> method that writes and then reads its own write is impossible — restructure so every value the
> write needs is known before the batch is composed.

Where an invariant genuinely needs atomicity, enforce it with a single conditional statement or a
unique index and have the service check the result. Two live examples: the stock ledger idempotency
guard, and `updateLeavingAnotherAdmin`, which carries "and another active admin exists" into the
`UPDATE` because counting first and writing second has a gap.

## 100 bound parameters per statement

A multi-row `INSERT ... VALUES` blows the limit at about 14 rows. Bind the rows as one JSON
parameter and expand with `json_each`: one statement and one parameter regardless of row count.

Drizzle has no builder for that, **and its `db.batch()` only accepts Drizzle query builders** — a
raw `db.run(sql)` is not a batchable item and fails at runtime with a confusing
`Cannot read properties of undefined (reading 'bind')`. So bulk inserts use raw D1 prepared
statements through `db.$client.batch()`. That is confined to `pick-lists.repository.ts` and
`stock.repository.ts` and covered by integration tests; everything else stays in Drizzle.

The stock take is the second case: a page of counts deletes those items' rows and writes one
baseline each, so both the `DELETE ... WHERE stock_item_id IN` and the insert take the item set as a
single JSON parameter. `inArray` would have been the obvious Drizzle answer and it is the wrong one
— it binds one parameter per id, so it fails somewhere north of a hundred items with the same
100-parameter error this section exists to describe.

## 50 queries per Worker invocation on the free plan

1,000 on paid. We develop against free and deploy to paid. No N+1, ever: load reference data once
and evaluate in memory. The pick-list generation path has a test that asserts its query count.

## 50 characters per `LIKE` or `GLOB` pattern — and it only fails once there is a row

A longer pattern is refused with `LIKE or GLOB pattern too complex`. Measured against this repo's
own binding rather than taken from documentation: 48 characters runs, 53 throws.

**The dangerous part is when it fails.** SQLite evaluates the pattern only when there is a row to
evaluate it against, so an over-long pattern runs perfectly against an empty table. Every test here
applies the migrations to a fresh database, which means a migration carrying one **passes the entire
suite** and then fails on the first deployment that has any data. Migration `0019` was written with
`'+44[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'` — 53 characters — and the suite was green;
it was a test that seeded a row first that found it.

Spell long patterns out with `length`, `substr` and a short class instead:
`length(v) = 13 AND substr(v, 1, 3) = '+44' AND substr(v, 4) NOT GLOB '*[^0-9]*'`. If you write a
character-class pattern in a migration, **seed a row and run it** — a green suite proves nothing
about it.

## 100 columns per table

Part of why dynamic referral answers are a JSON column rather than generic spare columns.

## No `ALTER COLUMN`, no `DROP CONSTRAINT`

Changing a column type or constraint means a full table rebuild. Two consequences, both deliberate
and both easy to "tidy up" by mistake:

- **Every PII column is nullable in SQL and required in Zod.** Requiredness lives in the schema
  module, not the DDL. Write `NOT NULL` on a PII column and it can never be purged.
- **Enums are CHECK constraints.** They were once enumerated generously, on the reasoning that
  adding a value later is expensive. That reasoning did not survive contact: `stock_ledger.movement_type`
  shipped with nine guessed values, migration `0011` rebuilt the table to get down to the six the
  charity actually wanted, and migration `0015` rebuilt it again to reach the **two** they actually
  use. Three rebuilds of one column, every one of them caused by guessing rather than asking.
  **Ask instead.**

## The stock ledger stopped being append-only, on purpose

It was append-only for good reasons and they are still good reasons — a mistake was additive, and
nothing could be lost by a bad `WHERE`. What changed is the requirement, not the engineering: the
charity does not want stock history from before the previous weekly count, so a count now deletes
the item's rows and writes it a fresh `opening_balance`, and taking an attendance outcome back
deletes that parcel's rows.

**The trade was made knowingly.** Destructive writes are not recoverable — D1's Time Travel restores
the whole database or nothing, so recovering a stock figure would mean rolling back referrals. The
argument that carried it is that the weekly count re-baselines every item from physical stock, so
the blast radius of a bad delete is one week and it repairs itself at the next take.

What follows for anyone touching this: **the `WHERE` clause on those two deletes is the highest-stakes
code in the stock module.** An append-only alternative was designed and rejected; do not reintroduce
it, and do not add a third delete.

## Dropping a column is usually not a rebuild

SQLite refuses `ALTER TABLE ... DROP COLUMN` only for a column named in an index, a `CHECK`, a
`FOREIGN KEY`, a generated column or the primary key. Migrations `0009` and `0010` are both
one-liners for that reason.

drizzle-kit generates a drop-and-recreate anyway and will justify it in a comment with "the table is
empty" — which is true of a fresh database, and of the test run, and of nothing else. On a
foreign-key parent that is the difference between a migration and a data loss.

**Read `migrations/0008_client-owned-referral-form.sql` before accepting a generated rebuild.** It
is the worked example of a safe rebuild on D1 and it records two traps found the hard way:

1. `PRAGMA foreign_keys=OFF` is a **silent no-op** on D1 — SQLite ignores it inside a transaction,
   and D1 runs implicit ones.
2. Even with `PRAGMA defer_foreign_keys=on`, SQLite's deferred-violation **counter only decrements
   on inserts into the parent**. Copying rows out before `DROP TABLE` never clears it, so the
   migration rolls back with `FOREIGN KEY constraint failed`. The fix is to park rows in a temp
   table, rebuild, rename, then re-insert.

A rebuild also fires `ON DELETE CASCADE` on children. `0008` accepted losing in-flight 15-minute
referral edit keys for that reason; know what yours will take with it.

**A leaf table needs neither dance.** `parcel_lines` is nobody's parent, so nothing counts against
the drop and a plain create-copy-drop-rename is correct — `0015` for `stock_ledger` and `0022` for
`parcel_lines` are both that simpler case, and both say so in their headers. Check whether anything
references your table before reaching for `0008`.

**Write the rebuilt table's `CHECK` with an unqualified column name.** drizzle-kit emits
`CHECK("__new_x"."col" ...)`, and `0008`, `0015` and `0018` all carry that form: D1's SQLite rewrites
the reference on `ALTER TABLE ... RENAME TO` and they apply cleanly, in production and under test.
**SQLite 3.51 does not rewrite it** — the rename fails with
`error in table x after rename: no such column: __new_x.col`. Run any of those three through the
`sqlite3` CLI on a current machine and watch it happen.

Nothing is wrong with the migrations already applied; a database never applies one twice. But
production is still at `0006` and will run every one of them forward, on whatever SQLite D1 is
running by then. `CHECK("col" ...)` means the same thing to every version and does not depend on the
rewrite. `0022` uses it.

**Emptying the children first is the other way to settle the counter**, and it is only available
when the rows are expendable. `0012` rebuilt `referrals` that way — `DELETE FROM parcel_lines`, then
`DELETE FROM parcels`, then `DROP TABLE referrals` — because Pete confirmed no table held data worth
keeping. Read the header of `0012` before copying it: with real data in the database the park-and-
re-insert dance in `0008` is the only correct shape, and `0012` would destroy pick lists.

## Time Travel is the backup

30 days on paid, whole-database restore only. **You cannot restore one table.**

## Two database-error traps, both silent

### 1. The constraint name is not on the thrown error, and SQLite names columns, not indexes

Drizzle wraps D1 failures. `error.message` is `Failed query: insert into …`; the SQLite text is
further down the `cause` chain. And even for a named unique index, SQLite reports
`UNIQUE constraint failed: table.column, table.column`. **Matching on an index name never fires** —
the guard appears to work and never triggers, which for the stock ledger would mean stock moving
twice. `isUniqueViolation` walks the chain and matches on columns; always name **every** column of a
composite index so it cannot match a different constraint on the same table.

### 2. Drizzle's error message contains the bound parameters — that is, the row

On `referrals` those are a referee's name, address and phone number. Unhandled errors are logged in
full and Workers Logs are not EU-pinned, so this is a data-protection failure rather than
untidiness. `toSafeError` redacts everything after `params:`.

`test/db-errors.test.ts` pins both behaviours against a real D1 failure rather than a hand-written
`Error`, because assuming the error's shape is exactly what caused the bugs.
