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
| **Stock item**        | A food line held in inventory: a name, a description, a category and a shelf number.                                |
| **Attendance**        | Whether a referred household turned up.                                                                             |

## Lifecycles

```
Referral:  pending_review → active → reviewed  (an unrecognised referrer starts at the left)
           pending_review → rejected           (the decision the address forced)
           active, reviewed → moved(session) | amended(answers) | cancelled
           rejected, cancelled                 (both terminal)
Pick list: draft → printed → confirmed        (draft → printed needs every parcel reviewed;
                                               confirmed = picking finished, list locked)
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

**The household's own details are amendable; the referrer's are not.** Name, date of birth, address,
postcode, referee phone, household counts, delivery and fuel flags, reason and answers can all be
corrected — a delivery goes to the address on the referral, so a wrong one there is a parcel on the
wrong doorstep. `referrerEmail` stays fixed because it is what the authorisation decision was made
on, and the referrer's name, phone and organisation with it. A correction overwrites: the audit
records which fields changed, never their values, so there is no history and no undo.

One consequence worth knowing before reading `divergence`: household counts **can** change after a
pick list is generated, so `changedHouseholds` is reachable. The parcel is not rewritten — the
snapshot is what the picker is packing — the difference is reported instead.

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

**A line quantity of `-1` is not a quantity.** It means the household asked for an item the client's
preference rules could not put a number on, and a team leader must decide. A parcel holding one
cannot be reviewed — and since printing waits for every parcel to be reviewed and attendance waits
for this one, that single check is what keeps it off a sheet and out of the ledger. It matters more
than it looks: `buildParcelIssue` negates the quantity, so a `-1` reaching attendance would _add_
one to stock. `-1` can only be created at generation, on a parcel that is by definition new and
unreviewed; `PUT /parcels/:id/lines` accepts `0` and above. **The charity settled this on
2026-08-11** — see `INITIAL_SPEC1.txt`, "Picking list".

**A parcel's pick-list information is written once, at creation, and never overwritten.** The
client composes it from the answers its form marks as belonging on a sheet and sends the finished
text as `pickListInformation`; the server stores it verbatim in `parcels.notes` and never reads an
answer to build it. Generation applies an entry only to a parcel it is creating, so sending the
whole session's information on every reconciliation is safe — from the moment the parcel exists the
note is the team leader's, editable through `PATCH /parcels/:id` until confirmation, and the printed
sheet carries it as saved. The invariant is the same one that protects a parcel's lines, and it
matters more here: the note is where an allergy is written down, and a reconciliation that reverted
a correction to one would be silent. Capped at `PARCEL_NOTES_MAX_LENGTH` (1,200) in Zod only —
`parcels.notes` is unbounded `TEXT`, so the limit lives at the boundary and nowhere else.

**A parcel reaches neither paper nor a household until it has been reviewed.** Attendance on an
unreviewed parcel is a `ConflictError`, and so is a print request — both `GET /pick-lists/:id/print`
and the `POST` that stamps it — while any parcel on the list is unreviewed. The `POST` is checked
even on a reprint, because reconciliation adds a late referral's parcel unreviewed and a second run
of sheets would otherwise carry it.

**Cancelling a referral marks its parcel `cancelled` rather than deleting it.** The parcel is the
record of what was picked, so `buildCancelParcelsFor` touches the attendance column and nothing
else — not the lines, not the note, not the pick number. From then on the parcel is outside every
"still to come" set: not waited on for review, left out of the print payload, not counted by
`confirmSession`, and refused by `record`. That last one is what stops a cancelled parcel being
flipped to `attended` and issuing stock for a household nobody expects.

> **The service's `cancelled` check is not what makes that safe.** `record` reads the parcel, then
> makes three more round trips before it commits, so a cancellation landing inside that window would
> be overwritten back to `attended` — with the stock gone. **`buildSetAttendance` and
> `buildParcelIssue` therefore both carry `attendance <> 'cancelled'`**, so the pair no-ops together
> rather than issuing stock against an attendance write that was refused, and `record` reads
> `meta.changes === 0` to tell the caller it lost the race. The up-front check only saves the work in
> the ordinary case. `<> 'cancelled'` and not `= 'pending'`: the same statement is how an outcome is
> taken back, so it must still move `attended` to `no_show` and back.

The write is guarded `WHERE attendance = 'pending'`, in the statement rather than in TypeScript
because there is no transaction to make read-then-write safe. So **an outcome already recorded
survives a later cancellation**: an `attended` parcel moved stock, and rewriting it would leave
`parcel_issued` rows on a parcel that no longer says anyone was fed, and would silently drop the
household out of the repeat-referral count. That is the server's judgement, not the charity's —
`OPEN-QUESTIONS.md` Q33.

Because cancellation has to reach `parcels` in the **same** `db.batch()` as the referral update,
`referrals.service.ts` takes the pick-lists _repository_, not its service: a service cannot hand
back an unexecuted statement, and a second write outside the batch would be free to fail on its own,
leaving exactly the state this removes with nothing recording it.

**A session cannot be closed while anybody is unmarked.** `POST /sessions/:id/confirm` refuses with
the outstanding pick numbers. No override, and no defaulting to no-show. A cancelled parcel is not
unmarked — it only ever blocked because it sat at `pending`.

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

**`adminInfo` — the administrators' own note about a household — is admin-only and single-referral
only.** The mapper emits it when the route asks for it, so `GET /referrals` never carries it and
`GET /referrals/{id}` does. Opt-in rather than opt-out because the list is the response somebody
widens by accident.

**A team lead sees `pending_review` referrals but never `rejected` ones** — absent from the list, and
`404` rather than `403` by id, because a team lead has no business learning that one exists.

**A referrer cannot change a referral at all.** There is no self-service window; they confirm what
they sent and phone the food bank. `referral_edit_keys` and the `x-referral-key` header were removed
in migration `0012`.

**Only the referee's own fields are purged**, plus `adminInfo`. The referrer's name, email and phone
survive, as does `reviewComment` — the retention period is about forgetting the household, not the
professional who referred them. `adminInfo` is the one field an administrator wrote that goes: it is
free text about the household, and who typed it does not decide whose data it is.

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
