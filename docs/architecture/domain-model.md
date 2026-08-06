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
Referral:  pending_review → active → reviewed  (an unrecognised referrer starts at the left)
           pending_review → rejected           (the decision the address forced)
           active, reviewed → moved(session) | amended(answers) | cancelled
           rejected, cancelled                 (both terminal)
Pick list: draft → printed → confirmed        (confirmed = picking finished, list locked)
Message:   reminder | staff_reply           (outbound, read on arrival)
           household_reply                  (inbound, the only kind ever unread)
           failure                           (nothing was sent; read on arrival)
           …all deleted 30 days after they arrive
Parcel:    pending → attended ⇄ no_show       (flips freely until the session is confirmed)
Session:   planned → confirmed | cancelled
```

**A referral whose referrer's email address is not on the authorised list is taken, not refused.**
It starts `pending_review` and an administrator accepts or rejects it. A recognised address starts
`active`.

**`reviewed` means an administrator has read the referral through**, and that is _all_ it means. It
is a second pass over every referral, not only the ones an unrecognised address held up, and it
exists so "which has nobody looked at yet?" is answerable — list `status=active`.

**Three statuses hold a place on a session**: `pending_review`, `active` and `reviewed`, via
`REFERRAL_STATUSES_HOLDING_A_PLACE`. They are also the statuses picked and sent SMS reminders: a
household holding a place may arrive, so the run-session client needs its named parcel. `rejected`
and `cancelled` release the place.

> **The trap this shape sets.** Anywhere that means "coming" must name `active` **and** `reviewed`.
> A `status === 'active'` comparison anywhere in this codebase is now a household disappearing off
> a session the moment somebody reads their referral — from the pick list, the listener sheet, the
> capacity count or a screen. Use the two exported sets; do not write the literal.

**`rejected` and `cancelled` are terminal.** A referral in either state cannot be amended, moved or
cancelled; `assertOpenToChange` is the shared guard, and `cancel` refuses a rejected one separately
so a rejection cannot be relabelled as a cancellation.

**Only the answers are amendable.** The fixed columns stand as the referrer sent them; a correction
goes into the form's "other information" answer, which reaches the picking screen and the listener
sheet. One consequence worth knowing before reading `divergence`: household counts can no longer
change after a pick list is generated, so `changedHouseholds` cannot currently be produced.

**Both status transitions are enforced in the `UPDATE`, not in the service.** `updateIfStatus`
carries `AND status = ?` into the statement so two administrators working the queue cannot both
write — the same shape as `updateLeavingAnotherAdmin`. Accepting requires `pending_review`; marking
read requires `active`.

## Text messages

**A reminder goes to every household holding a place** — `pending_review` included. Pick-list
generation uses the same set, so every household the team may text also has a named parcel in the
run-session client.

**A failure is not a reminder.** `referrals.sms_reminder_sent_at` is set only on a successful send,
so pressing the button again retries anybody it did not reach, for ever. That is the charity's
choice: better texted twice than not at all.

**Only the phone number leaves D1.** No name, no address, nothing identifying — in the request or
in the message body. That is the single exception to the residency rule in
[`../engineering/personal-data.md`](../engineering/personal-data.md), and it constrains the wording
as much as the request.

**A reply is matched by phone to the referral for the soonest session still to come.** A past
session is not a candidate, so a reply the morning after becomes a **loose reply** — a row with a
null `referral_id`, visible only to administrators. A reply is never dropped.

**The webhook is idempotent on `provider_message_id`.** The provider retries anything it did not
get a 200 for; the unique index is what stops the same text appearing twice on a volunteer's screen.

**Messages are deleted after thirty days, not anonymised** — including loose replies, which is the
only thing stopping them accumulating with no referral to count a period from.

## Rules the code must enforce, not merely document

**Stock moves on attendance, and only on attendance.** Generating or confirming a pick list does
**not** touch stock. Attended → stock decrements. **No-show → the parcel's movements are deleted**,
so a household that never came has taken nothing off the shelf, whether or not they were marked
attended first.

**Recording attendance must be idempotent.** A team lead will double-tap and the request may be
retried. Guarded by a unique index on `stock_ledger(parcel_id, stock_item_id, movement_type)`; the
service catches that specific violation and treats it as success. Use
`isUniqueViolation(error, 'stock_ledger.parcel_id', 'stock_ledger.stock_item_id', 'stock_ledger.movement_type')`
— naming every column matters, for reasons in [`../engineering/d1-constraints.md`](../engineering/d1-constraints.md).

**A recorded outcome can be taken back until the session is confirmed.** Marking a household a
no-show after marking them attended deletes that parcel's movements and puts the goods back. It is
the only way to fix a mis-tap, because the hand correction that used to do it is gone. Confirming
the session ends it: after that the outcome is a `ConflictError`.

**Stock moves two ways and no more**: `opening_balance`, written by the weekly count, and
`parcel_issued`, written by attendance. That list is the charity's. There is no shop, no donation,
no wastage and no hand correction — the count on the shelf next week is what the stock is. A third
value costs a rebuild of the whole ledger, and that column has already been rebuilt three times by
guessing, so it is a question for Pete rather than a line to add.

**A session cannot be closed while anybody is unmarked.** `POST /sessions/:id/confirm` refuses with
the outstanding pick numbers. No override, and no defaulting to no-show.

**The stock ledger holds one period, not a history.** The level is still `SUM(quantity_delta)`, and a
row is still never `UPDATE`d — but there are exactly **two deletes**, and both are the design rather
than a leak:

- A **stock take** deletes the counted item's rows and writes it one `opening_balance` at the counted
  figure. The count supersedes whatever the system believed; nothing before the previous take is
  kept.
- **Taking an attendance outcome back** deletes that parcel's rows, putting the goods back on the
  shelf.

Anything else that deletes a ledger row is a bug. The table was append-only until the charity
decided it did not want the history, and a comment somewhere may still say so — the reasoning for
the change is in `docs/engineering/d1-constraints.md`.

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
applies to the **list alone**: fetching one session by id and the pick-list routes are uncapped, and
that is settled — a team lead preparing picking in advance is doing the job, so the horizon shapes
what they are shown rather than what they may open.

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
