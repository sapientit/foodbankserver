---
paths:
  - 'src/modules/referrals/**'
  - 'src/modules/jobs/**'
  - 'src/core/log.ts'
  - 'src/http/**'
  - 'src/config/env.ts'
---

# Personal data and security rules

Referrals hold names, addresses, phone numbers and a reason for needing food. All of it is
sensitive. Background and the residency reasoning:
[`docs/engineering/personal-data.md`](../../docs/engineering/personal-data.md).

**The control that makes the rest work:** the D1 database is pinned to the EU jurisdiction, but
Workers compute runs globally and **Workers Logs are not EU-pinned**. So "never log PII" is a
compliance control, not hygiene. Nothing carrying a referee's name, address, phone number or reason
may leave D1 — not to logs, not to Analytics Engine, **not to any third-party fetch**.

That last clause survives the spreadsheet extract, and it is worth understanding why. The charity
keeps its records in a Google spreadsheet and the food bank's referrals go into it, personal columns
and all (`INITIAL_SPEC1.txt`, `#Sending referrals to the spreadsheet`; it closed Q24). But **this
server does not send them.** It hands the rows to an authenticated administrator over the ordinary
API — the same personal data it already returns on a referral screen — and that administrator's
browser writes them to the spreadsheet using their own Google account. There is no service account
here, no Google token reaches this server, and no code in this repo calls a Google API. **A design
that did all of that was built and then deliberately replaced; do not reintroduce it.**

So the server-side rule is unchanged and absolute: if you find yourself adding an outbound `fetch`
carrying a referee's details, you are doing something nobody agreed to.

What the charity accepted is real all the same, and lives in
[`docs/engineering/personal-data.md`](../../docs/engineering/personal-data.md): the purge cannot
reach a spreadsheet, `requireRole` does not follow a row into one, and residency past that point
depends on the Workspace rather than on the D1 jurisdiction. The controls that remain on this side
are that the extract is **admin-only**, and that every row goes through `toExtractRow()` — an
allowlist, so a column added to `referrals` cannot widen what an administrator is handed to write.

- **Logging goes through `core/log.ts`, which cannot accept PII by construction.** `LogContext`
  enumerates the permitted fields and they are all identifiers or counts, so
  `log.info('saved', { referral })` is a compile error. Adding a field to `LogContext` is a
  deliberate decision to be reviewed against this file. `console` is banned everywhere else.
- **Never build an error message from personal data.** Put an id in the message, not a name.
- Never put personal data in a URL path, a query string, or an error message.
- **Return only the fields a role needs**, enforced in the `toXxxResponse()` mapper — not by hoping
  a query forgets to select something. `reasonId` is admin-only; a pick list needs household size,
  not the reason.
- Refresh tokens and stock-take volunteer codes are returned once and stored **only as a SHA-256
  hash**.
- Secrets live in Worker secrets, validated in `config/env.ts`. Never commit a `.env`, never
  hardcode a credential, never log one.
- Do not add a third-party service that would receive request bodies without asking first.

## The purge

`purgeExpiredReferrals` (`modules/jobs/purge-referrals.ts`) **deletes** every referral older than
the retention period outright — `INITIAL_SPEC1.txt`, `#Forgetting a referral` — together with its
parcel (pick-list information included; parcel lines by cascade), any texts still filed against it,
and its audit events. The session, its pick list and the stock ledger stay. It runs as one
`db.batch()` of four set-based statements, so its cost does not grow with the number due — a
statement per referral would exceed the free plan's fifty queries per invocation. **Do not restore
the old anonymising design** (null the columns, keep the row), which this replaced on 2026-10-12.

It is wired into the nightly cron and **does nothing until `PII_RETENTION_DAYS` is set**. The period
is **fifteen months**, so the value is `456`. Do not change the period; fifteen months is also the
floor the repeat-referral count on the review screen depends on, and shortening it silently makes
that count under-report.

Anything new that stores a copy of a referral's personal data outside `referrals` must be reached by
this delete, or it outlives the household the charity promised to forget.

## Validation

- Validate at the edge, once, with Zod, then trust the parsed type inwards.
- Never trust a client-supplied id, role, quantity or status. **Re-derive parcel contents from
  household size on the server** — with one bounded exception, below.

### The one exception: preference lines at generation

`POST /sessions/:id/pick-list` accepts stock-item lines from the client. It has to: the client
evaluates each referral against its own release's preference rules, and the server stores those
releases but never reads their rules, let alone evaluates one. Refusing the data would not make the server the authority on parcel contents — it would
only move the same lines to a series of `PUT /parcels/:id/lines` calls after the fact, unvalidated
against the catalogue and outside the atomic write.

What stops this being general licence, and what must stay true:

- The server still decides **which referrals get a parcel** and **which model parcel** each one
  gets. The client cannot conjure a parcel or choose a household's model.
- Every supplied `stockItemId` is checked against the server's own catalogue **before a statement is
  composed**. An unknown id refuses the whole request; an inactive one is dropped.
- Every supplied `referralId` must be a referral **on that session**, checked in the same pass. One
  that is not refuses the whole request. A referral that is on the session but is not owed a parcel
  — cancelled, rejected, already picked — is ignored rather than refused: that one is an ordinary
  race, and failing a session's generation over it would be the wrong trade on a session morning.
- A supplied quantity can only ever **raise** the model's, never lower it — except `-1`, which is
  not a quantity but a refusal to guess, and which blocks review until a person settles it.
- It reaches **only parcels being created**. No client payload can alter a parcel that exists.

**The charity settled this as Option 2 on 2026-08-11** and it is now in `INITIAL_SPEC1.txt`, under
"Picking list". Do not extend it to another route by analogy: the reasoning is about who evaluates the form's rules, and nothing else in this system is
evaluated that way.
