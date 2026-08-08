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
- Referral edit keys and refresh tokens are returned once and stored **only as a SHA-256 hash**.
- Secrets live in Worker secrets, validated in `config/env.ts`. Never commit a `.env`, never
  hardcode a credential, never log one.
- Do not add a third-party service that would receive request bodies without asking first.

## The purge

`purgeReferralPii` nulls the identifying columns and drops the dynamic answers **whole**. It keeps
`adults`, `children`, `isDelivery` and `reasonId`, which are outside the PII block — once the
identifying columns are null those become statistics, which is how reporting survives a purge. That
only works because the reason is chosen from a list rather than typed.

It is wired into the nightly cron and **does nothing until `PII_RETENTION_DAYS` is set**. The
charity has settled the period at **twelve months** (`INITIAL_SPEC1.txt`, `#Forgetting a referral`),
so the value is `365` — but the variable is still unset, because setting it is what actually starts
deleting. Do not change the period; twelve months is also the floor the repeat-referral count on the
review screen depends on, and shortening it silently makes that count under-report.

## Validation

- Validate at the edge, once, with Zod, then trust the parsed type inwards.
- Never trust a client-supplied id, role, quantity or status. **Re-derive parcel contents from
  household size on the server** — never accept contents the client sends.
