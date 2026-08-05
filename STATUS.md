# Project status

What exists, what is waiting on configuration, what is deliberately unresolved, and what is not
built. Kept here rather than in `CLAUDE.md` so it can be corrected without touching the operating
instructions.

Requirements live in `INITIAL_SPEC1.txt`. Unanswered product questions live in `OPEN-QUESTIONS.md`.

---

## Implemented

The domain flow is complete end to end: **referral → session → pick list → attendance → stock.**

| Slice                          | What landed                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — platform**               | Hono on Workers, D1 with the EU jurisdiction, Drizzle, the Workers Vitest pool with self-testing migrations, health and readiness routes, error handling, core primitives.                                                                                                                                                            |
| **1 — auth**                   | `users` and `refresh_tokens`, dev login, the eight-hour sign-in with rotation that inherits its expiry, `requireAuth` / `requireRole`, `GET /auth/me`.                                                                                                                                                                                |
| **2 — sessions**               | `recurring_sessions` and `sessions`, the pure occurrence planner, the materialisation cron (wired to the real `scheduled` handler and to an admin trigger route), admin CRUD including ad hoc sessions and cancellation, the role-dependent staff list (6 weeks admin / 6 days team lead) and the unauthenticated 14-day public list. |
| **3 — referrers and reasons**  | `authorised_referrers` with email/domain precedence and `referral_reasons`, in `modules/referrers`. Pure matching module. Public `GET /public/referral-reasons`, `GET /public/organisations` and `POST /public/referrers/check`.                                                                                                      |
| **4 — referrals**              | `referrals` with the PII block and `audit_events`. Unauthenticated submission with capacity and reason checks; an unrecognised referrer lands as `pending_review` rather than a `403`; admin accept / reject with a one-line comment; admin amend, cancel and move-with-acknowledgement. **Real personal data lives here.**           |
| **5 — stock**                  | `stock_items` with shelf ordering, the append-only `stock_ledger` with all three idempotency guards, purchases, and stock takes that record a count and write an adjustment for the variance. Autocomplete; levels derived in one query.                                                                                              |
| **6 — model parcels and grid** | A flat, freely editable list of `model_parcels` and a single-row `parcel_grid`, with a preview endpoint. No versioning, deliberately.                                                                                                                                                                                                 |
| **7 — pick lists**             | `pick_lists`, `parcels`, `parcel_lines`. Generated on first view in five reads and one native D1 batch whatever the referral count; editable while draft _and_ after printing; locked on confirm. Print payload ordered by shelf.                                                                                                     |
| **8 — attendance**             | `POST /parcels/:id/attendance` issues or withholds a parcel; `POST /sessions/:id/confirm` closes the session, refused with no override while anybody is unmarked. A recorded outcome is final.                                                                                                                                        |
| **9 — hardening**              | Rate limiting on every unauthenticated route, Turnstile on referral submission, an allowlist CORS policy, and the PII purge job — all wired, not merely written.                                                                                                                                                                      |
| **10 — users**                 | `modules/users`: list, create and amend staff accounts, admin only. Logging in no longer creates accounts, so the seeded bootstrap admin is how a new database gets its first one.                                                                                                                                                    |

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

| Feature                  | State                                                                                                                                                                                                     | What it needs                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **PII purge**            | Runs nightly on the `17 2 * * *` cron and purges **nothing**. Clears only the referee's own fields; the referrer's details and `reviewComment` survive. **One `UPDATE` per row** — see the warning below. | `PII_RETENTION_DAYS`. The period is **Q2** and unanswered.                                               |
| **Turnstile**            | Verified on `POST /public/referrals` before parsing; **skipped when no secret is set**, which can only be development because production refuses to boot without one.                                     | A Turnstile widget and `TURNSTILE_SECRET_KEY`.                                                           |
| **CORS**                 | Allowlist middleware applied app-wide; with no origins configured it emits nothing, which is correct same-origin behaviour.                                                                               | `ALLOWED_ORIGINS`, only if the frontend is on a different origin. Never a wildcard.                      |
| **Rate limiting**        | Applied per route to all six public endpoints, keyed on `cf-connecting-ip`. The binding is **optional at runtime**, so it is inert in the test runner and in a plain `wrangler dev`.                      | Nothing in code — the bindings are declared in `wrangler.jsonc`. It is live wherever the binding exists. |
| **Access token signing** | Refuses to start without a key.                                                                                                                                                                           | `wrangler secret put AUTH_JWT_SECRET --env production`.                                                  |

**One hazard in the purge, for whoever answers Q2.** `purgeReferralPii` issues one `UPDATE` per
candidate row. That is fine on a nightly tick clearing a handful of referrals, but the **first** run
after `PII_RETENTION_DAYS` is finally set will face every referral older than the period at once —
months of history — and the free plan allows 50 queries per invocation. Set the period before there
is a backlog, or make the purge a single `UPDATE ... WHERE referred_at < ? AND pii_purged_at IS
NULL` first. This predates the referral review work and was not changed by it.

See [`docs/operations/production.md`](./docs/operations/production.md) for the full go-live
sequence.

---

## Deliberately unresolved — only Pete closes these

Tracked in `OPEN-QUESTIONS.md`, marked with `x-assumed` in `openapi.yaml`. **Do not answer one,
including one this repo raised.** `grep x-assumed openapi.yaml` is the standing agenda.

| #       | Question                                                                        | What the code does meanwhile                                                                                             |
| ------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Q2**  | How long is personal data kept?                                                 | Purge runs, purges nothing. Blocks going live with real data.                                                            |
| **Q12** | May any form answers survive a purge?                                           | Drops the answers blob **whole** — with no form definition the server cannot tell a personal answer from a harmless one. |
| **Q13** | Should a stock take's variance be distinguishable from a hand correction?       | Writes `correction`, identified by its `stock_take_id`. Do not build reporting that assumes either way.                  |
| **Q14** | Does the team lead's six-day horizon stop them _opening_ a session further out? | Caps `GET /sessions` only. Fetching one session by id and the pick-list routes are uncapped.                             |
| **Q21** | Is there a `reviewed` status, and does every referral get reviewed?             | Four statuses; only an unrecognised referrer's referral waits. `referral details.txt` item 7 hints at a wider pass.      |
| **Q22** | What does "approve (authorise referrer)" write to the authorised list?          | Not built. `POST /referrals/{id}/accept` approves once; there is no second button yet.                                   |
| **Q23** | Which fields may an administrator change on a referral?                         | The wide pre-existing set. Item 7 says three fields; two of the three names map onto nothing that exists.                |

---

## Not implemented

Tracked so it is not mistaken for finished work.

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
