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
may leave D1 — not to logs, not to Analytics Engine, not to any third-party fetch.

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

It is wired into the nightly cron and **does nothing until `PII_RETENTION_DAYS` is set**. The period
is deliberately unset: see **Q2** in `OPEN-QUESTIONS.md`. Do not pick one.

## Validation

- Validate at the edge, once, with Zod, then trust the parsed type inwards.
- Never trust a client-supplied id, role, quantity or status. **Re-derive parcel contents from
  household size on the server** — never accept contents the client sends.
