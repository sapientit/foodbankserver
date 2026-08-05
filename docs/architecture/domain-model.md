# Domain model

**`INITIAL_SPEC1.txt` is the source of truth for what the charity wants.** This file does not
restate it. What follows is the shared vocabulary, the lifecycles the code implements, and the rules
that must be _enforced in code_ rather than merely documented — with a pointer to the spec statement
each one serves.

## Vocabulary

Use these words in code, tests and API paths. Do not invent synonyms.

| Term                  | Meaning                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Session**           | A scheduled distribution slot. Standard ones repeat weekly; occurrences can be re-timed, cancelled or added ad hoc. |
| **Recurring session** | The template a session is generated from.                                                                           |
| **Referral**          | A request to feed a household, made by an authorised organisation or person, **without authentication**.            |
| **Household**         | The people a referral feeds. Its size drives parcel contents.                                                       |
| **Parcel**            | One household's food for one session.                                                                               |
| **Pick list**         | The set of parcels for a session, generated on first view.                                                          |
| **Stock item**        | A food line held in inventory, with a shelf number.                                                                 |
| **Attendance**        | Whether a referred household turned up.                                                                             |

## Lifecycles

```
Referral:  pending_review → active | rejected  (an unrecognised referrer starts here)
           active → moved(session) | cancelled
           rejected, cancelled                 (both terminal)
Pick list: draft → printed → confirmed        (confirmed = picking finished, list locked)
Parcel:    pending → attended | no_show       (both terminal: no correction)
Session:   planned → confirmed | cancelled
```

**A referral whose referrer's email address is not on the authorised list is taken, not refused.**
It starts `pending_review` and an administrator accepts or rejects it. A recognised address starts
`active`.

**A `pending_review` referral holds its place on the session** — it counts against capacity
everywhere, via `REFERRAL_STATUSES_HOLDING_A_PLACE`. `rejected` and `cancelled` release it.

**`rejected` and `cancelled` are terminal.** A referral in either state cannot be amended, moved or
cancelled; `assertOpenToChange` is the shared guard, and `cancel` refuses a rejected one separately
so a rejection cannot be relabelled as a cancellation.

**The review decision is enforced in the `UPDATE`, not in the service.** `reviewIfPending` carries
`AND status = 'pending_review'` into the statement so two administrators working the queue cannot
both write — the same shape as `updateLeavingAnotherAdmin`.

## Rules the code must enforce, not merely document

**Stock moves on attendance, and only on attendance.** Generating or confirming a pick list does
**not** touch stock. Attended → stock decrements. **No-show → no ledger entry at all**, because
nothing was ever issued; the parcel is simply unpacked.

**Recording attendance must be idempotent.** A team lead will double-tap and the request may be
retried. Guarded by a unique index on `stock_ledger(parcel_id, stock_item_id, movement_type)`; the
service catches that specific violation and treats it as success. Use
`isUniqueViolation(error, 'stock_ledger.parcel_id', 'stock_ledger.stock_item_id', 'stock_ledger.movement_type')`
— naming every column matters, for reasons in [`../engineering/d1-constraints.md`](../engineering/d1-constraints.md).

**A recorded outcome is final.** The _contradicting_ outcome is a `ConflictError`; a mis-tap is put
right through the audited stock-adjustment path. `parcel_returned` was removed from the CHECK
constraint in migration `0011`, so a reversal cannot be recorded even by hand.

**Stock moves six ways and no more**: `opening_balance`, `purchase`, `donation`, `parcel_issued`,
`wastage`, `correction`. That list is the charity's. It is deliberately short rather than generous —
a seventh costs a rebuild of the whole ledger, so it is a question for Pete, not a line to add.
`POST /stock/adjustments` offers all six. A stock take's variance is written as `correction` and
identified by its `stock_take_id`; whether that distinction is wanted is **Q13** and unanswered, so
do not build reporting that assumes either way.

**A session cannot be closed while anybody is unmarked.** `POST /sessions/:id/confirm` refuses with
the outstanding pick numbers. No override, and no defaulting to no-show.

**The stock ledger is append-only.** Never `UPDATE` or `DELETE` a ledger row. The level is
`SUM(quantity_delta)`; a stock take records a _count_ and writes an adjustment for the variance.

**Session materialisation never `UPDATE`s an existing session row.** That is what makes an admin's
re-timed or cancelled occurrence safe by construction.

**Only `admin` ever receives the reason for referral**, and only `admin` receives `reviewComment`.
Enforce both in the response mapper, not by hoping a query forgets to select them.

**A team lead sees `pending_review` referrals but never `rejected` ones** — absent from the list, and
`404` rather than `403` by id, because a team lead has no business learning that one exists.

**A referrer cannot change a referral at all.** There is no self-service window; they confirm what
they sent and phone the food bank. `referral_edit_keys` and the `x-referral-key` header were removed
in migration `0012`.

**Only the referee's own fields are purged.** The referrer's name, email and phone survive, as does
`reviewComment` — the retention period is about forgetting the household, not the professional who
referred them.

## Three session windows, and they are not the same number

A frequent source of confusion, so it is written out once:

| Window      | Who                             | Where enforced                  |
| ----------- | ------------------------------- | ------------------------------- |
| **6 weeks** | Materialisation cron            | `materialise-sessions.ts`       |
| **6 weeks** | `GET /sessions` for an admin    | `sessions.service.listSessions` |
| **6 days**  | `GET /sessions` for a team lead | `sessions.service.listSessions` |
| **14 days** | Unauthenticated public list     | `sessions/public.routes.ts`     |

The horizon is applied from the `Actor`, never from the request — a `to` beyond it is **clamped**,
so no query parameter widens it. It caps looking forward only; past sessions are untouched. It
applies to the **list alone**: fetching one session by id and the pick-list routes are uncapped,
which is **Q14** and unanswered.

## Where the parcel contents come from

Contents are a lookup, not a calculation: named **model parcels** and a **30-cell grid** of every
household size (1–5 adults × 0–5 children), each cell holding the _name_ of a model parcel. Bigger
households clamp into the corner.

**Model parcels and the grid are not versioned, and must not become so.** When a pick list is
generated the contents are **copied** into `parcel_lines`. That copy is the entire immutability
guarantee: a parcel already picked is unaffected by any later edit, and the next pick list picks the
change up. A draft/publish lifecycle on top would be ceremony protecting something already
protected.

## The referral form is not ours

The questions ship with the frontend. This repo holds no form definition, no versioning and no
publish flow, and **does not validate the answers** — `POST /public/referrals` stores what it is
given. Answers are a JSON column, stored and returned verbatim, each carrying the key it was asked
under. The only checks are size bounds (`MAX_ANSWERS*` in `config/constants.ts`), which exist
because the submission is unauthenticated.

This is why `pick-lists.mapper.ts` matches several plausible keys for dietary needs rather than one
agreed name: nobody on this side of the boundary owns that vocabulary.
