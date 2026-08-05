---
paths:
  - 'test/**'
  - 'vitest.config.ts'
---

# Testing rules

- **Every behaviour change ships with a test. Bug fixes start with a failing test.**
- Tests run inside **real workerd against real Miniflare-backed SQLite**, so CHECK constraints,
  partial unique indexes, `batch()` atomicity and `json_each` behave as they will in production.
  `test/setup.ts` applies the real migrations, which makes **the migrations self-testing**.
- Drive HTTP through `buildApp().request(...)`. Use `SELF.fetch()` only for the smaller set of tests
  that need genuine end-to-end middleware ordering.
- Unit-test pure modules directly — the rules engine, date maths, shelf sorting, referrer matching.
  Those are the highest-value tests here and they only exist because the code is written to allow
  them.
- Assert on behaviour and public responses, not internal calls. **Do not mock what you own.**
- Name a test as the rule it enforces:
  `records stock movements exactly once when attendance is submitted twice`.

## Three things that will waste an afternoon

- **`vi.useFakeTimers()` does not work.** Inject a `Clock` from `core/clock.ts`. This is the only
  way to test expiry.
- **Storage isolation is per test file, not per test.** Reset shared state in `beforeEach`, and
  `await` every storage operation — an unawaited write leaks across the isolation boundary.
- **Coverage must use `provider: 'istanbul'`** — V8 coverage is unsupported in workerd.

## Where to spend the effort

Prioritise the **stock ledger** and the **pick-list state machine**. That is where a bug means a
household goes hungry or the inventory silently drifts. `test/attendance.test.ts` has a concurrency
test that is the one that actually proves the ledger's unique index; `test/db-errors.test.ts` pins
error shapes against a real D1 failure rather than a hand-written `Error`, because assuming the
shape is exactly what caused the bugs it guards.
