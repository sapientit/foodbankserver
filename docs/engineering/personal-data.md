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

### The spreadsheet: personal data leaves, but not by this server's hand

The charity keeps its records in a Google spreadsheet and decided, knowingly, that the household's
own details go into it — name, date of birth, address, postcode, phone — along with the reason, the
form answers and the review comment. That closed **Q24** and is written into `INITIAL_SPEC1.txt`,
`#Sending referrals to the spreadsheet`. A spreadsheet of households with the households left out
would not have been worth keeping.

**The server is not what sends them, and the distinction is not a technicality.** An administrator's
browser obtains Google Sheets consent against their own Google account, reads a session's referrals
from this API — the same personal data the referral screens already return to that same
administrator — and writes them to the spreadsheet itself. No Google credential is sent to, stored
by, or used by this server, and nothing here calls a Google API. So the residency control above
holds unchanged on the server side: data still leaves D1 only to an authenticated administrator over
the API.

Three consequences the charity accepted, recorded here because no code can enforce any of them:

- **Residency past the browser is the Workspace's business.** A Google Workspace with EU data
  regions configured keeps the residency the D1 jurisdiction was chosen for; a personal Gmail
  account does not. Whoever owns the spreadsheet owns that decision.
- **The purge cannot reach it.** Fifteen months clears rows in D1 only. A name in the spreadsheet
  stays until somebody deletes it by hand, so "we hold it for fifteen months" is true of this system
  and not of the charity's records as a whole.
- **Roles stop at the API boundary.** `requireRole` and the response mappers do not follow a row
  into a spreadsheet. Everyone it is shared with sees every column, including `reviewComment`, which
  inside the system is admin-only because it can name a referrer or record a suspicion about one.

What bounds it on this side: the extract is **admin-only**, it is **started deliberately by a person**
rather than by a timer, and every row passes through `toExtractRow()` — an allowlist, so a column
added to `referrals` cannot silently widen what leaves.

`adminInfo` is the worked example of that allowlist doing its job: it is free text about a
household, it is purged at fifteen months, and it is **not** an extract column. A field the purge
clears must not be written somewhere the purge cannot reach.

### `sms_messages` is the other table holding personal data

Everything in this document was written about `referrals`. Since text reminders
there is a second table: `sms_messages` holds a household's phone number and the
**free text they wrote back**, which can be anything — why they need food, who
has left, what they are frightened of. Treat it as at least as sensitive as a
referral, and note the two things that make it different:

- **It is written by a public, unauthenticated route.** The webhook is the only
  other open write in the system besides referral submission, and unlike that
  one it is not a form a person filled in — so the shared secret and the rate
  limiter are the whole of the door.
- **It is deleted, not anonymised, after thirty days** — including the loose
  replies that belong to no referral. A referral keeps counts once its name is
  gone; a text message has nothing underneath it worth keeping. See
  `purge-sms.ts`.

Never log a body or a number: `LogContext` has `smsMessageId` and deliberately
nothing else.

### The one exception, and how narrow it is

**SMS reminders send a phone number to TheSMSWorks, plus a first name in the message text and
nothing else.** The charity settled the original, narrower version of this on 2026-08-06 — no name
at all — and revised it on 2026-09-21 to allow a first name in the greeting, so that a reminder now
reads "Hi Alice this is Guildford Food Bank" rather than staying anonymous. Everything else the
2026-08-06 decision ruled out still holds: no surname, no address, no date of birth, no reason for
referral, and nothing in the message body beyond that first name that would identify the household.
That narrower set is what makes the exception acceptable rather than a hole in the rule, and it is a
constraint on the **message text** as much as on the request: a reminder that named a surname, or
gave an address, would still breach it.

Replies come back the same way and are stored in D1 like any other personal data — a household's
own words are theirs, and everything in this document applies to them once they land.

Nothing else about this changes. The rule above still holds for every other outbound path, and a
second exception is a decision for the charity, in the spec, not an extension of this one. See
`INITIAL_SPEC1.txt`, "SMS reminders and replies", and
[`../architecture/domain-model.md`](../architecture/domain-model.md).

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

## Forgetting a referral: deleted, not anonymised

At fifteen months the nightly purge (`modules/jobs/purge-referrals.ts`) **deletes** the referral —
`INITIAL_SPEC1.txt`, `#Forgetting a referral`. Nothing about it survives in D1: its parcel goes with
it (pick-list information included, and the parcel lines by cascade), and so do any texts still filed
against it and its audit events. The session, its pick list and the stock ledger stay; they are the
session's figures, not the household's. Long-term reporting — "we fed 340 households, 890 people,
22% for benefit delay" — comes from the extract spreadsheet, not from this database.

This replaced an earlier purge that nulled the referee's columns and kept the row (2026-10-12). The
personal columns on `referrals` are still nullable from that design; its `pii_purged_at` stamp was
dropped in migration `0041`.

The retention period is **fifteen months**, settled by the charity on 2026-08-06 at twelve months
and revised to fifteen on 2026-09-09, recorded in `INITIAL_SPEC1.txt` under `#Forgetting a referral`.
The job is written, tested and scheduled — it deletes nothing until `PII_RETENTION_DAYS` is set to
`456`, because setting it is the moment deletion begins.

Fifteen months is not only a privacy decision. The repeat-referral count on the admin review screen
looks back fifteen months and matches on date of birth, postcode and phone, which go when the
referral is deleted. A shorter period does not fail loudly; it makes that count under-report and tells an
administrator a household is new when it is not. The two numbers are one decision.
