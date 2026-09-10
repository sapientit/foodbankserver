# Domain model

**`INITIAL_SPEC1.txt` is the source of truth for what the charity wants.** This file does not
restate it. What follows is the shared vocabulary, the lifecycles the code implements, and the rules
that must be _enforced in code_ rather than merely documented — with a pointer to the spec statement
each one serves.

## Vocabulary

Use these words in code, tests and API paths. Do not invent synonyms.

| Term                    | Meaning                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session**             | A scheduled distribution slot. Standard ones repeat weekly; occurrences can be re-timed, cancelled or added ad hoc.                                                               |
| **Recurring session**   | The template a session is generated from.                                                                                                                                         |
| **Referral**            | A request to feed a household, made by an authorised organisation or person, **without authentication**.                                                                          |
| **Household**           | The people a referral feeds. Its size drives parcel contents.                                                                                                                     |
| **Parcel**              | One household's food for one session.                                                                                                                                             |
| **Pick list**           | The set of parcels for a session, generated on first view.                                                                                                                        |
| **Stock item**          | A food line held in inventory: a name, a description, a category and a shelf number.                                                                                              |
| **Stock-take grouping** | A coarser heading above `category` that the grouped stock take is organised by. Every item belongs to one, unless it is a crate member.                                           |
| **Crate**               | Several stock items shelved and counted together as one line, in fixed proportions, behind one shelf number.                                                                      |
| **Attendance**          | Whether a referred household turned up.                                                                                                                                           |
| **First-time review**   | An administrator's dedicated decision, per referral, about whether the household has been fed before — `unreviewed`, `no_previous_referral`, or a recorded previous-session date. |
| **Voucher range**       | The one administrator-maintained Christmas-voucher date range. Applies to a session inclusively, by session date.                                                                 |

## Lifecycles

```
Referral:  pending_review → active → reviewed  (an unrecognised referrer starts at the left)
           pending_review → rejected           (the decision the address forced)
           active, reviewed → moved(session) | amended(answers) | cancelled
           rejected, cancelled                 (both terminal)
           rejected | cancelled | no-show → copied onto another session
                                               (a NEW referral, `reviewed`; the original is untouched)
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

**A terminal referral is exactly what can be _copied_**, and copying is the only forward path out of
one. `POST /referrals/{id}/copy` is offered where the original can no longer come to anything —
`cancelled`, `rejected`, or a household marked `no_show` — and produces a **new** referral,
`reviewed`, on a session the administrator chooses. The original is not touched: a no-show stays a
no-show on the day it happened, which is the same reasoning that refuses a move once an outcome
exists. A referral still on its way to being fed is moved, not copied, and the two must never be
alternatives for the same referral. `INITIAL_SPEC1.txt`, `#Copying a referral`.

**A purged referral is terminal in a stronger sense**: amend, move, cancel, accept, reject,
mark-reviewed and copy are all refused once `piiPurgedAt` is set. `assertNotPurged` is the shared
guard for the paths that read first; `updateIfStatus` carries `pii_purged_at IS NULL` for the two
that do not. Fifteen months on there is nothing left to act on — `INITIAL_SPEC1.txt`,
`#Referral maintenance`.

**`outcome` is not `status`.** `status` is what became of the referral; `outcome` — `attended` |
`no_show` | `booked`, derived from the referral's parcels — is what became of the household on the
day. A cancelled referral reads `status: cancelled` with `outcome: booked`, deliberately: nothing
happened on the day, and the cancellation is recorded on the status. One vocabulary serves both
`Referral.outcome` and `RepeatReferralMatch.outcome`.

**`firstTimeReviewStatus` is not `status` either, and moves on its own separate, one-way track.**
Every referral starts `unreviewed` regardless of where it sits on the `status` pipeline above;
`POST /referrals/{id}/first-time-review` is the only route that moves it, to `no_previous_referral`
or to `previous_session` with a recorded date, and never back. Nothing here is gated on the
referral's own `status` — settled by Pete, closed Q49: this will not come up in practice, since the
screen is never offered against a referral that isn't open to it. `INITIAL_SPEC1.txt`,
`#Christmas voucher and first-time selection`.

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

**`sms_messages.session_id` is a snapshot taken at insert, never re-derived.** It is stamped once
from `referral.session_id` as it stood at that moment. `referrals.service.ts`'s `move()` overwrites
`referrals.session_id` in place with no cascade to this table, so if a message's session were
computed live by joining through the referral instead, it would silently follow the household to
wherever it is moved next. Null means the same as a null `referral_id` — no session was known when
the row was written — and is treated as a loose reply throughout.

**The administrator inbox (`GET /sms-messages`) shows a phone number only when it has something on
it besides a sent reminder, but shows that number whole.** `listInbox` returns every message within
retention for a phone number that has at least one `staff_reply`, `household_reply` or `failure` in
that window — a number that was only ever reminded is not returned at all — and once a number
qualifies, its reminders come back alongside everything else, because a reply answers a reminder.
`GET /sms-messages/attention-summary` tells an administrator about far less than even that list
shows: an unread `household_reply` needs an administrator only when it is unmatched or its
snapshotted session has since moved to `confirmed` or `cancelled`; one on a `planned` or
`in_progress` session stays the team leader's responsibility, and an administrator may view it but
it never contributes to `unreadTotal`. Nothing here creates an ownership, handover, acknowledgement
or preference record — a message is still simply read or unread, and `POST /sms-messages/{id}/read`
(now usable on any unread household reply, not only a loose one) touches only the one row named.

## Rules the code must enforce, not merely document

**A session's `deliveryCapacity` is a number within its overall `capacity`, not a boolean.** It
replaced `deliveriesAllowed` outright (migration `0025`) — a session that takes no deliveries at all
is simply one with `deliveryCapacity = 0`, there is no separate flag. `POST /public/referrals` refuses
(`409`) a delivery referral once the session's delivery places are gone, including the zero case; a
collection referral is never affected by delivery capacity, however full it is. This check and the
cutoff check (above) are both scoped to public submission only — `move`/`copy`/admin amend keep
exactly their existing capacity-only warn-and-`acknowledgeOverCapacity` pattern, unchanged. The public
list represents delivery state as words (`deliveryAvailability: not_offered | full | available`), not
numbers, matching the list's existing refusal to leak raw capacity/booked counts.

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

**Stock moves three ways now**: `opening_balance`, written by the weekly count; `parcel_issued`,
written by attendance; and `correction`, a team lead's hand fix to one item's level between one
count and the next (`POST /stock/items/:id/corrections`, migration `0035`). There is still no shop,
no donation and no wastage — the count on the shelf next week is what the stock is — but the charity
accepted that a shelf drifts from what the system believes for everyday reasons it does not need a
name for, and settled that a team lead may put an item right by hand rather than waiting for the
next count. **A correction is a signed delta, not a recount**: it is added to whatever the ledger
already holds, the opposite of a stock take, which takes a total and lets the server work out the
difference. Like a stock take's variance, no reason is recorded and there is no history to read
back — the level just changes. It is `...staff`, the same as `POST /stock/take` it belongs with:
both `admin` and `team_lead` may call it. (An earlier reading made it `team_lead`-only; that
misread `INITIAL_SPEC1.txt` — an administrator does everything a team leader does, without
exception.) This was a genuine third value added to the `CHECK` constraint — a rebuild of the whole
ledger — but unlike the guesses that caused the previous two rebuilds, this one is a decision Pete
made directly, recorded in `INITIAL_SPEC1.txt`, "#Stock maintenance".

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
because there is no transaction to make read-then-write safe. **An outcome already recorded
therefore survives** — but as of 2026-08-15 it never has to, because the cancellation itself is
refused: the charity settled that a household who has collected, been delivered to or been marked as
not turning up can no longer be cancelled at all (`INITIAL_SPEC1.txt`, `#Referral maintenance`). The
referral `UPDATE` carries `NOT EXISTS (… attendance <> 'pending')` for the same reason
`buildMoveReferral` does, so the two conditions cannot disagree if an outcome lands between the
service's read and the batch. The parcel guard stays as the second half of the same rule.

Because cancellation has to reach `parcels` in the **same** `db.batch()` as the referral update,
`referrals.service.ts` takes the pick-lists _repository_, not its service: a service cannot hand
back an unexecuted statement, and a second write outside the batch would be free to fail on its own,
leaving exactly the state this removes with nothing recording it.

**The voucher instruction is calculated on every read and never stored.** `Parcel.voucherInstruction`
(`modules/voucher-config/derivations.ts#voucherInstructionFor`) reads the session's date, the
voucher range and the referral's `firstTimeReviewStatus`/`firstTimeReviewDate` fresh on every call to
`GET /sessions/{sessionId}/pick-list` and `GET /pick-lists/{id}` — nothing is written onto `parcels`
and nothing is computed at generation. An administrator may make the first-time-review decision after
a pick list already exists, and the spec is explicit that the Run a session screen must reflect the
decision as it stands **now**, not as it stood when the list was made. It is **not** on
`PrintParcel`: the voucher is handed over at the session, not off the sheet carried round the hall.
`Parcel.firstTimeMarker` (`derivations.ts#firstTimeMarkerFor`) is the same kind of derivation for the
same screen, and deliberately narrower: `first_time` or `admin` or no marker at all, never the
historic date — that is what makes it safe to hand to a team lead when `firstTimeReview` itself is
admin-only.

`ListenerSheetHousehold` carries `firstTimeMarker` and `voucherInstruction` too — the **same two
enums** with the same values, for the listener, who is the person actually talking to the household.
`referrals.service.ts#listenerSheet` reads the voucher-config row and calls the same
`firstTimeMarkerFor` / `voucherInstructionFor`, so the sheet and the Run a session screen can never
disagree. No new derivation, and nothing exposed that the two parcel fields do not already expose.

**`referrals.first_time_review_status` carries no `CHECK` constraint**, the same deliberate omission
`collection_method` made in migration `0032`: `referrals` is a foreign-key parent (`parcels`,
`sms_messages`), so a `CHECK` added to it forces the drop-and-recreate rebuild `migrations/0008`
exists to explain. Validity is enforced in `referrals.schema.ts` only. `voucher_config`, a brand new
table nothing references, carries real `CHECK`s: the same singleton pattern `parcel_grid` uses, plus
`end_date >= start_date`.

**Moving deletes the parcel; cancelling keeps it.** The two look alike and are opposites. A cancelled
household really was one that session prepared a parcel for, so the parcel stays and says
`cancelled`. A moved household is not that session's business at all, so the parcel on the session it
leaves is deleted outright — nothing was handed over, no stock moved, and left in place it would sit
on that morning's list as somebody still to come and be packed a second time. This shares the
cancellation batch's reasoning exactly: the delete rides the same `db.batch()` as the referral update
and the audit row, through the same pick-lists _repository_ dependency.

**A referral whose parcel has an outcome cannot be moved at all** — a `409`, and not covered by the
confirmed-session rule, because a session stays open until _every_ household has an outcome, so an
`attended` household sits on an open session with its stock already gone. The delete is guarded
`WHERE attendance = 'pending'` in the statement for the same reason the cancellation write is: there
is no transaction, so an outcome recorded between the check and the batch must lose quietly rather
than take its `parcel_issued` rows with it. `stock_ledger.parcel_id` carries **no** foreign key, so
an orphan there would be silent rather than refused — which is what makes the guard load-bearing
rather than belt-and-braces.

This is a delete on `parcels`, not on the ledger: the two ledger deletes below are unchanged and this
is not a third.

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

**A counted crate decomposes into ordinary ledger deltas, one per member, computed independently.**
`crate-decomposition.ts` is `round(enteredCount * sizePerCrate * memberPercent / 100)` per member —
nothing corrects the small drift independent rounding can leave against the entered total, and
nothing should: a stable, individually-explicable figure per member beats a total forced to agree.
The decomposed deltas are fed through the same `recordStockTake` pipeline a direct count uses, so
"zero writes nothing" and the delete-then-insert atomicity apply unchanged.

**Crate writes hard-validate; stock-item writes don't.** `crates.service.ts` refuses a crate born (or
amended into) fewer than two members, an unknown grouping, or a percentage table that does not total
exactly 100 — ordinary `400`/`409`s. `GET /stock/validation` is a **separate, non-blocking** report
computed fresh from current data (`stock-validation.ts`, pure) for drift the write-time checks cannot
see afterwards: an item's shelf moving out from under its crate, an item ending up both directly
grouped and a crate member, and so on. A stock-item create or patch never fails because of it — see
`INITIAL_SPEC1.txt`, `#Stock maintenance`.

**Session materialisation never `UPDATE`s an existing session row.** That is what makes an admin's
re-timed or cancelled occurrence safe by construction.

**Only `admin` ever receives the reason for referral**, and only `admin` receives `reviewComment`.
Enforce both in the response mapper, not by hoping a query forgets to select them.

**`adminInfo` — the administrators' own note about a household — is admin-only and single-referral
only, with one settled exception.** The mapper emits it when the route asks for it, so
`GET /referrals` never carries it and `GET /referrals/{id}` does. Opt-in rather than opt-out because
the list is the response somebody widens by accident.

The exception is `POST /referrals/search`, where every result row carries the note — the only
response holding more than one referral that does. The charity settled it on 2026-08-15
(`INITIAL_SPEC1.txt`, `#Searching for a referral`): that screen is an administrator on the phone to a
household, and the note is wanted at the same moment the causes are. It stays bounded because the
route is admin-only outright — a team lead gets a `403`, not a thinner row — which is why the field
is required-and-nullable there rather than optional. Do not extend it to another list by analogy;
the reasoning is about that one screen.

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
| **14 days** | Unauthenticated public list     | `sessions/public-window.ts`     |

The public list is the one with a **near** end as well as a far one: referrals for a session close
at 16:00 `Europe/London` the day before it runs, so the soonest session offered is tomorrow's up to
and including 16:00 today and the day after tomorrow's from 16:01 — 16:00 itself still makes the
deadline. The far end stays 14 days from today, so the
list shortens over the afternoon rather than sliding forward. **The cutoff now applies to submission
as well as to the list**, as of 2026-08-19 — `POST /public/referrals` refuses (`409`) a referral
against a session whose cutoff has passed, reversing the earlier settled position that a referrer
still typing at five past four should not lose the form. `firstOfferableDate` in
`sessions/public-window.ts` is the one predicate both the list and submission now share.

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
