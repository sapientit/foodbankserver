# Handling personal data

The mandatory rules are in [`.claude/rules/pii-security.md`](../../.claude/rules/pii-security.md).
This file is the reasoning behind them.

Referrals contain names, addresses, phone numbers, and a reason for needing food. Treat all of it as
sensitive.

## Residency is why logging is a compliance control

The D1 database is pinned to the EU jurisdiction (`--jurisdiction=eu`) and **this cannot be changed
after creation** — it is fixed at `wrangler d1 create` time, which is why the README makes a point
of it.

But Workers compute runs globally, and **Workers Logs are not EU-pinned**. So "never log PII" is not
hygiene here; it is the control that keeps personal data inside the jurisdiction the database was
pinned to. Nothing carrying a referee's name, address, phone number or reason for referral may leave
D1 — not to logs, not to Analytics Engine, not to any third-party fetch.

`core/log.ts` enforces this **by construction** rather than by discipline: `LogContext` enumerates
the permitted fields and they are all identifiers or counts, so `log.info('saved', { referral })`
does not compile. Adding a field to `LogContext` is a deliberate decision to be reviewed against
this document. `console` is banned everywhere else.

`test/pii-logging.test.ts` asserts against real log output rather than trusting the types, because
the type system only covers the paths that go through the logger.

## Why error messages matter as much as logs

Errors are logged in full when they escape a handler, so an error message built from personal data
is a log line containing personal data. Put an id in the message, not a name. The same reasoning
covers URL paths and query strings, which land in access logs the application does not control.

Drizzle's own errors are the sharp case — they contain the bound parameters, which on `referrals`
is the row itself. See [`d1-constraints.md`](./d1-constraints.md).

## What survives a purge, and why

`purgeReferralPii` nulls the identifying columns and keeps `adults`, `children`, `isDelivery` and
`reasonId`, which sit outside the PII block. Once the identifying columns are null the referee is no
longer identifiable, so those become statistics — which is how "we fed 340 households, 890 people,
22% for benefit delay" survives a purge.

**That only works because the reason for referral is chosen from a maintained list rather than
typed.** Free text would have to go with the rest.

Dynamic answers are dropped **whole**. The referral form is client configuration, so the server has
no definition telling it which questions asked for personal data, and an answer that cannot be
classified has to be assumed personal. Keeping a key because it looks harmless is the one mistake a
purge cannot take back. Whether the charity needs any answers to survive for reporting is **Q12** in
`OPEN-QUESTIONS.md`.

The retention period itself is **Q2** and deliberately unanswered. The schema isolates PII so a
purge needs no table rebuild, the job is written, tested and scheduled — it simply purges nothing
until `PII_RETENTION_DAYS` is set. Guessing a period and deleting somebody's data on that guess
would be worse than doing nothing.
