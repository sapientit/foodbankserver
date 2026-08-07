# Project status

What exists, what is waiting on configuration, what is deliberately unresolved, and what is not
built. Kept here rather than in `CLAUDE.md` so it can be corrected without touching the operating
instructions.

Requirements live in `INITIAL_SPEC1.txt`. Unanswered product questions live in `OPEN-QUESTIONS.md`.

---

## Implemented

The domain flow is complete end to end: **referral → session → pick list → attendance → stock.**

| Slice                          | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — platform**               | Hono on Workers, D1 with the EU jurisdiction, Drizzle, the Workers Vitest pool with self-testing migrations, health and readiness routes, error handling, core primitives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **1 — auth**                   | `users` and `refresh_tokens`, dev login, the eight-hour sign-in with rotation that inherits its expiry, `requireAuth` / `requireRole`, `GET /auth/me`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **2 — sessions**               | `recurring_sessions` and `sessions`, the pure occurrence planner, the materialisation cron (wired to the real `scheduled` handler and to an admin trigger route), admin CRUD including ad hoc sessions and cancellation, the role-dependent staff list (6 weeks admin / 6 days team lead) and the unauthenticated 14-day public list.                                                                                                                                                                                                                                                                                                                      |
| **3 — referrers and reasons**  | `authorised_referrers` with email/domain precedence and `referral_reasons`, in `modules/referrers`. Pure matching module. Public `GET /public/referral-reasons`, `GET /public/organisations` and `POST /public/referrers/check`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **4 — referrals**              | `referrals` with the PII block and `audit_events`. Unauthenticated submission with capacity and reason checks; an unrecognised referrer lands as `pending_review` rather than a `403`; admin accept / reject with a one-line comment, accept-and-authorise-the-referrer, and `POST /referrals/{id}/review` for the read-through pass that makes `active` the unread pile. Amendment covers **the household's own details and the answers**; the referrer's own details stay fixed, `referrerEmail` above all. A correction overwrites and nothing keeps what it used to say. Plus cancel and move-with-acknowledgement. **Real personal data lives here.** |
| **5 — stock**                  | `stock_items` with shelf ordering, `stock_ledger` with the parcel idempotency guard, and `POST /stock/take` — a page of counts that **replaces** the counted items' history with one `opening_balance` each. Autocomplete; levels derived in one query. No shopping, wastage or hand corrections; see migration `0015`.                                                                                                                                                                                                                                                                                                                                    |
| **6 — model parcels and grid** | A flat, freely editable list of `model_parcels` and a single-row `parcel_grid`, with a preview endpoint. No versioning, deliberately.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **7 — pick lists**             | `pick_lists`, `parcels`, `parcel_lines`. Generated on first view in five reads and one native D1 batch whatever the referral count; editable while draft _and_ after printing; locked on confirm. Print payload ordered by shelf.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **8 — attendance**             | `POST /parcels/:id/attendance` issues a parcel or takes it back — a no-show **deletes that parcel's movements**, which is now the only way to fix a mis-tap. Reversible until `POST /sessions/:id/confirm`, which is refused with no override while anybody is unmarked.                                                                                                                                                                                                                                                                                                                                                                                   |
| **9 — hardening**              | Rate limiting on every unauthenticated route, Turnstile on referral submission, an allowlist CORS policy, and the PII purge job — all wired, not merely written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **10 — users**                 | `modules/users`: list, create and amend staff accounts, admin only. Logging in no longer creates accounts, so the seeded bootstrap admin is how a new database gets its first one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **11 — session guards**        | Two rules `INITIAL_SPEC1.txt` stated and nothing enforced: a **confirmed session is sealed** (a referral on one can no longer be amended, cancelled or moved off it), and a **session cannot be cancelled while anybody holds a place**, refused with `details.booked`. `test/session-guards.test.ts`.                                                                                                                                                                                                                                                                                                                                                     |
| **12 — listener sheet**        | `GET /sessions/:sessionId/listener-sheet` — one sheet per session listing every household by surname: name, reason **label**, fuel flag and the answers whole for the client to pull _Cause Details_ from. The only place a team leader receives the reason. Row set is **Q26** and assumed. `test/listener-sheet.test.ts`.                                                                                                                                                                                                                                                                                                                                |

| **13 — SMS reminders** | `sms_messages` and `modules/sms`. A team leader texts a session's households from `POST /sessions/:id/sms-reminders`; TheSMSWorks delivers; replies arrive on the public `POST /webhooks/sms`, matched by phone to the referral for the soonest upcoming session, and unmatched ones are kept for admins. Counts poll from `/sms-summary`. Everything is deleted after 30 days by the nightly job. Sessions gained `deliveryTime` and `deliveriesAllowed`. |

| **14 — fuel help list** | A third role, `fuel_admin`, and `GET /fuel-help-list` in `modules/fuel-help` — the role's entire surface, plus `/auth/me`. Households who asked for fuel help, were given their parcel, at a confirmed session, in the last fourteen dates counting today; oldest first. Name, address, postcode, phone, session date and the answers whole; **no reason, date of birth, household counts or delivery flag**. One query, joined through the parcel rather than the referral so a moved referral reports the session it was actually fed at. Migration `0018` rebuilt `users` to widen the CHECK and **dropped the unused `volunteer`**. `test/fuel-help-list.test.ts`. |

**Removed:** there was a `modules/forms` — versioned `form_definitions` / `form_fields`, a publish
flow and an answer-validation module. The referral form moved to the client, migration `0008`
dropped both tables and `referrals.form_definition_id`, and the referrer and reason routes it also
hosted moved into `modules/referrers`.

**Also removed:** the fifteen-minute self-service edit window. `referral_edit_keys`, the
`x-referral-key` header, `GET|PATCH|DELETE /public/referrals/{id}` and the nightly key-sweep job are
all gone (migration `0012`). A referrer confirms what they sent and phones the food bank if it needs
changing, which is what they already did once the window closed. `AUDIT_ACTOR_KINDS` still admits
`referral_key` so audit rows written while it existed stay readable.

---

## Implemented but awaiting configuration

These are written, tested and wired. They do nothing, or do less, until a value is set. **None of
them is a gap in the code.**

| Feature                  | State                                                                                                                                                                                                     | What it needs                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **PII purge**            | Runs nightly on the `17 2 * * *` cron and purges **nothing**. Clears only the referee's own fields; the referrer's details and `reviewComment` survive. **One `UPDATE` per row** — see the warning below. | `PII_RETENTION_DAYS=365`. The period is settled at twelve months; the variable is still unset.                            |
| **Turnstile**            | Verified on `POST /public/referrals` before parsing; **skipped when no secret is set**, which can only be development because production refuses to boot without one.                                     | A Turnstile widget and `TURNSTILE_SECRET_KEY`.                                                                            |
| **CORS**                 | Allowlist middleware applied app-wide; with no origins configured it emits nothing, which is correct same-origin behaviour.                                                                               | `ALLOWED_ORIGINS`, only if the frontend is on a different origin. Never a wildcard.                                       |
| **Rate limiting**        | Applied per route to all six public endpoints, keyed on `cf-connecting-ip`. The binding is **optional at runtime**, so it is inert in the test runner and in a plain `wrangler dev`.                      | Nothing in code — the bindings are declared in `wrangler.jsonc`. It is live wherever the binding exists.                  |
| **Access token signing** | Refuses to start without a key.                                                                                                                                                                           | `wrangler secret put AUTH_JWT_SECRET --env production`.                                                                   |
| **SMS reminders**        | Every route, the webhook and the 30-day purge are live. With no credentials the send path records **every household as a failure** rather than pretending — which is visible on the screen, not silent.   | `SMS_API_KEY`, `SMS_SENDER` (the reply number) and `SMS_WEBHOOK_SECRET`. Production refuses to boot without the last one. |

**One hazard in the purge, for whoever sets `PII_RETENTION_DAYS`.** `purgeReferralPii` issues one `UPDATE` per
candidate row. That is fine on a nightly tick clearing a handful of referrals, but the **first** run
after `PII_RETENTION_DAYS` is finally set will face every referral older than the period at once —
months of history — and the free plan allows 50 queries per invocation. Set the period before there
is a backlog, or make the purge a single `UPDATE ... WHERE referred_at < ? AND pii_purged_at IS
NULL` first. This predates the referral review work and was not changed by it.

See [`docs/operations/production.md`](./docs/operations/production.md) for the full go-live
sequence.

---

## Agreed but not yet built

**None of it is built.**

| Change                                                             | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Google Sheets export](./docs/planned/google-sheets-export.md)** | Agreed 2026-08-05. A cron pushes each confirmed session and all its referrals into a Google Sheet, resumably, via a service account. Both rules it leans on are now enforced. Blocked on **Q24** for its row shape.                                                                                                                                                                                                                                                                                                                                                   |
| **Remove the audit trail**                                         | Agreed 2026-08-07. **The charity never asked for one** — it was built unprompted and `INITIAL_SPEC1.txt` has never mentioned it except as a by-the-way reason accounts are not deleted, which the stock and attendance records carry on their own. See `#Referral maintenance`. Drop `audit_events`, the six `recordAudit` calls in `referrals.service.ts`, `recordAudit`/`listAuditFor` in the repository, and the tests asserting them. Note `listAuditFor` already has **zero callers** and nothing exposes the table, so nothing outside this repo depends on it. |

The plan lists what must change in the same commit.

---

## Deliberately unresolved — only Pete closes these

Tracked in `OPEN-QUESTIONS.md`, marked with `x-assumed` in `openapi.yaml`. **Do not answer one,
including one this repo raised.** `grep x-assumed openapi.yaml` is the standing agenda.

| #       | Question                                                 | What the code does meanwhile                                                                                             |
| ------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Q12** | May any form answers survive a purge?                    | Drops the answers blob **whole** — with no form definition the server cannot tell a personal answer from a harmless one. |
| **Q26** | Who appears on the listener sheet?                       | Active and awaiting-review households; cancelled and rejected ones are left off. `x-assumed` on the operation.           |
| **Q24** | Does the Google Sheets export carry names and addresses? | Not built. Blocks the export's row shape; personal columns would also outlive the twelve-month purge.                    |
| **Q27** | Is a forgotten referral anonymised or deleted?           | Anonymised — the row stays and its counts remain reportable. Deleting is blocked by the `parcels` FK anyway.             |

---

## Not implemented

Tracked so it is not mistaken for finished work.

- **TheSMSWorks request and webhook shapes are read defensively, not verified.** The send call and
  the inbound payload parser accept several spellings of the provider's field names because no live
  account has been available to confirm them against. The tests pin our own behaviour, not theirs.
  **Verify both against a real account before go-live**, and simplify the parsing once they are
  known.
- **A session's `deliveriesAllowed` is recorded but not enforced.** An administrator can mark a
  session as taking no deliveries, and it is on both the staff and public session responses — but
  `POST /public/referrals` still accepts `isDelivery: true` against one. The referral form is
  expected to stop offering delivery meanwhile. Agreed with Pete on 2026-08-06 as a deliberate
  later fix, not an oversight; when it lands it should be a `422`.

- **No Google identity provider.** `AUTH_MODE=google` currently means "no way to log in". The
  contract is in place, so this is one file — see
  [`docs/architecture/authentication.md`](./docs/architecture/authentication.md).
- **Deactivating a user does not revoke their access token.** They lose access at the next refresh,
  so within fifteen minutes. Immediate lockout would need a query per request — the thing stateless
  JWTs exist here to avoid — or a revocation list. Neither is worth it until someone asks.
- **A pick list has no "sync".** It reports divergence from its referrals but does not add parcels
  for referrals that arrived afterwards; an admin handles those by hand.
- **Model parcels cannot express exclusions** (no pork, gluten free). Dietary needs are a dynamic
  answer surfaced on the parcel for the picker to substitute manually — and since the client owns
  the form, `pick-lists.mapper.ts` matches several plausible keys rather than one agreed name.
  Adding exclusions is a v2 conversation with the charity, not a gap to be quietly filled in.
