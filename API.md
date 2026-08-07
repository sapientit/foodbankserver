# Food Bank API — client guide

Everything a frontend needs that a schema cannot express. The shapes live in
[`openapi.yaml`](./openapi.yaml); this covers the sequences, the rules about who
sees what, and the handful of things that will otherwise be got wrong.

Base path is `/api/v1`. Everything is JSON. There is no HTML, no server-side
rendering and no PDF — printing and layout are the client's.

## Generating types

```bash
npx openapi-typescript openapi.yaml -o src/api/schema.d.ts
```

Worth doing on day one. The contract is then enforced by your compiler rather
than by anyone remembering to read this.

---

## 1. Signing in

```
POST /api/v1/auth/dev-login   { "email": "pete@foodbank.org" }
  → 200 { accessToken, expiresAt, user: { id, email, displayName, role } }
  + Set-Cookie: foodbank_refresh=…  HttpOnly; Secure; SameSite=Strict
```

The `role` in that response is what you choose the menu from — `admin`,
`team_lead` or `fuel_admin`.

**The email must already have a user record.** Signing in never creates an
account; an admin does, through `/api/v1/users`. An unknown address gets `401`
with the same message as any other failed login, and a deactivated one gets
`403`. The display name and role come from that record — sending them here
changes nothing.

**Two rules about the tokens.**

Hold the access token **in memory only**. Not `localStorage`, not a cookie you
set yourself. It lasts fifteen minutes — or until the sign-in ends, if that is
sooner, so the last one of a sign-in may be a short one. Losing it on a page
reload is fine because refresh recovers it.

Never touch the refresh cookie. It is `HttpOnly`, so JavaScript cannot read it,
and it is scoped to `/api/v1/auth` so it is not attached to any other request.
That is deliberate: it means a CSRF against a domain endpoint has nothing to
ride on.

### The refresh cycle

Every authenticated request sends `Authorization: Bearer <accessToken>`. When
one returns **401**, refresh once and retry:

```
POST /api/v1/auth/refresh        (no body — the cookie carries it)
  → 200 { accessToken, expiresAt, user }   retry the original request
  → 401                                     sign the user out
```

Do this in one place — an interceptor or fetch wrapper — not per call site.

**A sign-in lasts eight hours, counted from when the user signed in.** Refresh
keeps the access token alive within that window but never extends it: the
replacement refresh token carries the same expiry as the one it replaced. So a
`401` from `/auth/refresh` means the eight hours are up (or the cookie is gone)
and the user genuinely has to sign in again. There is no idle timeout — a
sign-in ends eight hours in whether they were working or not. Do not build a
"keep me signed in" affordance; there is nothing behind it.

**Refresh exactly once per failure, and never in parallel.** Each refresh
rotates the token, and a rotated token is spent: presenting it again gets a
`401`. If two requests 401 at the same moment and both refresh, the second gets
that `401` — but the sign-in is untouched and the cookie the first refresh set
is still good, so **do not sign the user out on it**. Retry instead. Queueing
concurrent 401s behind a single in-flight refresh avoids the situation
altogether and is still the right shape.

On reload, call `POST /api/v1/auth/refresh` to rebuild UI state from the cookie —
not `/auth/me`. `/me` sits behind `requireAuth`, and after a reload there is no
access token in memory, so it can only 401. You would then refresh anyway, and
the refresh response already carries the user — including `displayName`, which
`/me` does not return. So `/me` costs an extra round trip to learn less.

`/me` is for re-reading the current actor mid-session, not for booting.

### What changes when Google auth arrives

The response shape does not, and neither does the rejection: a valid Google
identity that is not a known user gets the same `401` the development login
gives today. What changes is only how the email is established — asserted by
the caller now, proved by Google then.

### Managing who may sign in

Admin only.

```
GET   /api/v1/users?includeInactive=true
POST  /api/v1/users          { email, displayName, role }   → 201
PATCH /api/v1/users/{id}     { displayName?, role?, isActive? }
```

Four things to build around:

**There is no signup screen to build.** Accounts are invitation-only: an admin
creates one here and nothing else ever does. A fresh deployment arrives with a
single admin account already seeded, which is how the first real one gets made
— so there is no "first run" flow either.

**Email is not amendable.** It is the login identity and what the audit trail
means by "who". To correct one, deactivate the account and create the right one.

**There is no delete.** Users are named by the stock ledger, audit events and
attendance records. `isActive: false` is the retirement path; the account stops
working at the next refresh.

**A change is refused with `409` if it would lock everyone out** — demoting or
deactivating yourself, or doing either to the last active admin. Show the
message; it says which.

A role change takes effect on the user's **next refresh**, so up to fifteen
minutes later. Deactivation is the same: their current access token keeps
working until it expires. If someone must be locked out immediately, that is a
gap — say so rather than assuming this closes it.

---

## 2. Roles

Three roles. Use them for menus; **never for access control.**

|                                                 | `admin` | `team_lead` | `fuel_admin` |
| ----------------------------------------------- | ------- | ----------- | ------------ |
| Run a session: pick lists, printing, attendance | ✅      | ✅          | ❌           |
| Read sessions, stock, referrals, model parcels  | ✅      | ✅          | ❌           |
| See the session list more than six days ahead   | ✅      | ❌          | ❌           |
| The weekly stock take                           | ✅      | ✅          | ❌           |
| Create or amend sessions and referrals          | ✅      | ❌          | ❌           |
| Maintain the stock item list                    | ✅      | ❌          | ❌           |
| Model parcels and the household grid            | ✅      | ❌          | ❌           |
| Referrers and reasons for referral              | ✅      | ❌          | ❌           |
| User maintenance                                | ✅      | ❌          | ❌           |
| **See why someone was referred**                | ✅      | ❌          | ❌           |
| **The fuel help list**                          | ✅      | ❌          | ✅           |

**`fuel_admin` is not a lesser `admin`, and a menu built by subtracting from
one will be wrong for it.** It reaches `GET /api/v1/fuel-help-list` and
`GET /api/v1/auth/me` and nothing else at all — every other endpoint answers
`403`. Its whole screen is one list. See §5e.

The server re-checks the role on every request from the signed token. If someone
edits `role` in your app's state they will see extra menu items and get `403` on
every one of them — harmless, but show the right menu anyway.

### Field-level visibility

A **team lead does not receive** `reasonId`, `referrerEmail`, `referrerPhone` or
`reviewComment` on a referral. The fields are absent, not null. Treat them as
optional in your types — `openapi-typescript` already will.

Why: the reason for referral is the most sensitive thing in the system. It can
mean financial hardship, domestic abuse, or immigration status. A picker needs
household size, not that. `reviewComment` is withheld for the same kind of
reason — it can name a referrer or record a suspicion about one.

A team lead also **does not see rejected referrals at all**. They are missing
from `GET /referrals` whatever you filter by (`status=rejected` returns an empty
list rather than an error), and `GET /referrals/{id}` on one is a `404`. Pending
referrals they do see, marked by `status`: the household may well turn up, and
the team lead is the person in the hall when they do.

### How far ahead each role sees

`GET /api/v1/sessions` returns a different window depending on who asks:

| Caller                      | Window                                            |
| --------------------------- | ------------------------------------------------- |
| `admin`                     | everything materialised — six weeks               |
| `team_lead`                 | today → today + 6 days, inclusive                 |
| nobody (`/public/sessions`) | today → today + 14 days, and only if it has space |

Counted in `Europe/London`, so the window turns over at London midnight, not at
`00:00Z`.

The cap comes off the access token, so **`from` and `to` cannot widen it.** A
`to` past a team lead's horizon is clamped back to it — you get a shorter list,
not a `403`. A `from` past it returns `{ "sessions": [] }`. A narrower `to`
still narrows. Only the far end is capped: a team lead can still list the
sessions just gone.

Do not build a team lead's calendar as "six weeks, some of it empty" — from
their token there is nothing beyond day six to fetch. An admin's planning view
and a team lead's shift view are different screens.

The public window being **longer** than the team lead's is deliberate, not a
bug: a referrer needs notice to book somebody in, a team lead needs the shift
in front of them.

**Not capped, and settled that way:** `GET /api/v1/sessions/{id}` and every
pick-list route. A team lead holding a session id can still open it and its pick
list however far out it is. Preparing a fortnight's picking in advance is the
job, so the horizon shapes the list a team lead is shown and is not a wall
around the sessions beyond it.

---

## 3. The public referral flow

Unauthenticated, and the only open write in the system. Rate limited per IP.

```
1  GET  /api/v1/public/sessions           which sessions have space
2  GET  /api/v1/public/organisations      the organisation dropdown
3  POST /api/v1/public/referrers/check    is this address on the list?
4  GET  /api/v1/public/referral-reasons   the reason dropdown
5  POST /api/v1/public/referrals          submit  → 201, always
```

### An unrecognised referrer is no longer refused

`POST /public/referrals` **never returns `403`.** The address is still checked,
but it decides the referral's `status`, not whether it is taken at all:

| `POST /public/referrers/check` | Resulting `status`         |
| ------------------------------ | -------------------------- |
| `authorised: true`             | `active` — booked          |
| `authorised: false`            | `pending_review` — waiting |

A `pending_review` referral **holds its place on the session**, so it counts
against capacity and `GET /public/sessions` stops offering a session once the
places are gone, reviewed or not. It receives a parcel and appears on the pick
list and printed sheet, so the run-session client has the same households as SMS
reminders. It stays out only once cancelled or rejected.

So call step 3 as the referrer types their address, but not to block them — use
it to pre-fill `referrerOrganisation` when it comes back authorised, and to warn
them that the referral will need checking when it does not. Do not gate the form
on it.

`referrerOrganisation` is now **yours to send**, not derived. An unrecognised
referrer has no authorised-referrer row to derive it from, which is why the form
asks: the dropdown from step 2 for one on the list, the free-text box beside it
for one that is not. When the address is authorised, send back what step 3
returned so the value matches what the server would have derived — the server
still records its own match separately, so your string never decides which
organisation gets the credit.

### The form itself is yours

**The server does not hold the referral form.** The questions are configuration
in your application: you change them, see them in the test system, and publish
them by releasing a new version of the client. There is no draft, no publish
call, and no form-maintenance screen to build.

What the server does with `answers` is store it and give it back:

- It is **not validated** against anything. Required, max length, option lists,
  and which questions are shown at all are your rules to enforce, before you
  submit.
- Keys are yours and must stay stable. A referral captured last year comes back
  with the keys it was captured under, so **never reuse a key for a different
  question** — that is what silently changes the meaning of old referrals.
- Unknown keys are stored, not dropped. Nothing on the server has a list to
  compare them against.
- Size is the only limit: at most 100 keys, keys at most 60 characters, 16KB
  serialised. That is a bound on an unauthenticated write, not form validation,
  and no real form comes near it.

The reason dropdown (step 4) is the exception that stays server-side: it is a
maintained lookup, admin-editable, and the referral points at one by `reasonId`.

**Six things are fixed columns, not answers**, because the charity reports on
them or the server acts on them: `refereeFirstName`, `refereeSurname`,
`refereeDateOfBirth`, `referrerName`, `referrerOrganisation` and
`needsFuelHelp`. Send them as named fields on `ReferralSubmission`, not as
`answers` keys. The two questions that follow from `needsFuelHelp` — pre-payment
meter, permission to ring — are ordinary answers.

**After a retention purge, `answers` comes back empty** along with the referee's
own fields — the server cannot tell which answers were personal, so it drops all
of them. The referrer's name, email and phone survive, as does `reviewComment`:
the point of the purge is to stop holding the household's details, not to lose
track of who referred them.

### Deliveries can be switched off per session

`Session` and `PublicSession` both carry **`deliveriesAllowed`**. False means
that session has nobody to drive.

**The server does not enforce it.** A referral with `isDelivery: true` to such a
session is still accepted today — so until that lands, _the form is the only
thing stopping it_. Do not offer the delivery option when `deliveriesAllowed` is
false. The gap is deliberate and recorded in `STATUS.md`; when the server starts
refusing, it will be a `422`, so a form that already hides the option will not
notice the change.

`Session` also carries **`deliveryTime`** (`HH:MM` London, or null for "the same
as `startTime`") — the time the food bank tells a household to expect a
delivery, because the van does not go out when the hall opens. It is a time to
show and to put in a text message; **nothing is scheduled or routed from it**,
which is why there is no `deliversAtUtc` beside it. It is absent from
`PublicSession` deliberately: an unauthenticated caller has no use for it.

### Turnstile

`POST /public/referrals` requires a Turnstile token in the
`cf-turnstile-response` header whenever the server has a secret configured —
**always in production**, never in local development. Two failure modes to
handle:

- Tokens are **single-use**. Never retry a submission with the same token; get a
  fresh one from the widget.
- Tokens **expire after five minutes**. Somebody filling in a long form slowly
  will hit this and get a `400` saying the check expired. Reset the widget and
  let them resubmit rather than showing a generic error.

### There is no edit window

The fifteen-minute self-service window is **gone**, along with `editKey`,
`editKeyExpiresAt`, the `x-referral-key` header and
`GET|PATCH|DELETE /api/v1/public/referrals/{id}`. Once a referral is submitted
the referrer cannot change it; they phone the food bank, as they already did
once fifteen minutes had passed.

What replaces it is a confirmation screen. `ReferralReceipt` carries the fixed
fields back so the referrer can see what they sent, plus `status` — show them
plainly that a `pending_review` referral is waiting to be checked rather than
letting them assume a place is settled.

### Deciding and reading a referral (admin only)

**These are two different passes and the status now says which has happened.**
Deciding settles a referral the referrer's address held up; reading is the pass
an administrator makes over _every_ referral.

```
POST /api/v1/referrals/{id}/accept   { comment?, authoriseReferrer? }  → Referral (active)
POST /api/v1/referrals/{id}/reject   { comment?: string }              → Referral (rejected)
POST /api/v1/referrals/{id}/review   (no body)                         → Referral (reviewed)
```

Accept and reject are `409` if the referral is not `pending_review`; review is a
`409` if it is not `active`. `comment` is one line, at most 200 characters, and
**replaces** any earlier one — there is no decision history and no decision
timestamp. `referredAt` is the timestamp, and it is the referrer's submission.
Who decided or read it is recorded but never returned.

Accepting cannot fail for a full session: the referral was already holding its
place. Rejecting releases it.

**`status: "reviewed"` is `active` in every respect that matters to a screen.**
It holds its place, it is picked, it is on the listener sheet, and it is on the
printed sheet. The only thing it adds is that somebody has read it — which makes
`GET /referrals?status=active` the pile still to read, and that is what the
charity asked for the status for.

> **Filter on `active` and `reviewed` together wherever you mean "coming".**
> This is the one place a previously-shipped screen goes quietly wrong: treating
> `active` alone as the live set makes a household vanish from a list the moment
> an administrator reads their referral. The server-side sets have all been
> widened; yours have not.

### The second accept button

`referral details.txt` asked for "approve (once)" and "approve (authorise
referrer)". The second is `authoriseReferrer` on the accept body:

```
POST /api/v1/referrals/{id}/accept
{ "authoriseReferrer": { "organisationName": "Guildford Borough Council" } }
```

It accepts this referral _and_ adds the referrer to the authorised list, so the
next referral from that address is not held up. Three things to build around:

- **The address only, never the domain.** One person the charity has decided to
  trust is not everybody who works where they work. There is no domain option on
  this endpoint on purpose; a domain rule is a deliberate trip to the authorised
  referrers screen.
- **`organisationName` is required, and the administrator types it.** Do not
  pre-fill it silently from `referrerOrganisation` — that is free text the
  referrer chose, and it is how the list ends up holding "Guildford BC",
  "Guildford Borough Council" and "guildford borough council" as three
  organisations. Offering the existing names as suggestions is the useful shape;
  the charity asked for the administrator to key it and confirm.
- **A `409` means nothing happened.** If that address is already on the list the
  referral is _not_ accepted either, so the next step is plain accept. A `422`
  means the referral has no referrer address to authorise at all.

### Amending a referral

**Breaking, and it restores fields that were previously refused.**
`PATCH /api/v1/referrals/{id}` accepts the household's own details again:

```
refereeFirstName   refereeSurname     refereeDateOfBirth
refereeAddress     refereePostcode    refereePhone (nullable)
adults             children           isDelivery      needsFuelHelp
reasonId           answers            sessionId (a move)
```

A referrer who mistypes an address, or a household that moves between being
referred and being fed, has to be correctable — a delivery goes to the address on
the referral, so a wrong one there is a parcel on the wrong doorstep. **A full
referral edit form is the right shape again.**

**Send only what changed.** Every field is optional and an omitted one is left
alone, so a one-field correction is a one-field request. `answers` is the
exception and still **replaces** the stored set outright rather than merging —
you hold the form, so a key you leave out has been removed.

**The referrer's own details are still refused**: `referrerName`,
`referrerPhone`, `referrerOrganisation` and above all `referrerEmail`, which is
what the accept-or-hold decision was made on. The body is strict, so sending one
is a `400` naming it rather than a `200` that silently changed nothing.

**There is no undo and no history.** A correction overwrites, and the audit
records which fields changed but never their values — deliberately, so it cannot
become a second copy of every referral that outlives the twelve-month purge. So
there is nothing to show as "previously", and no way to recover a value typed
over. Confirm corrections that look destructive.

**`reasonId` must be a reason the charity currently offers** — a retired one is a
`422`. A referral already citing a retired reason keeps it.

**Which key is "other information" is still yours.** The server holds no form
definition and does not police which answers moved. Corrections are still worth
putting there as well as in the field: a corrected address reaches the driver, a
note saying why reaches the person handing the bag over — the answers surface
beside the parcel on the picking screen and on the listener sheet.

---

## 4. Running a session

```
POST /api/v1/sessions/{sessionId}/pick-list     generate or reconcile
GET  /api/v1/sessions/{sessionId}/pick-list     read the existing list
GET  /api/v1/pick-lists/{id}/print              one sheet per parcel
POST /api/v1/pick-lists/{id}/print              mark printed
     …pick, adjusting lines as stock runs out…
POST /api/v1/pick-lists/{id}/confirm            lock the list
     …the session happens…
POST /api/v1/parcels/{id}/review                per household, BEFORE attendance
POST /api/v1/parcels/{id}/attendance            per household
POST /api/v1/sessions/{sessionId}/confirm       close the session
```

The review step is not optional: attendance on an unreviewed parcel is a `409`.

### Generating

Generated on first view. `POST` is idempotent — calling it again reconciles any
household holding a place (`pending_review`, `active` or `reviewed`) which does
not yet have a parcel, and reports how many it added in `parcelsCreated`. It
never alters an existing parcel, so
manual changes and the household snapshot stay intact. Once the list is
confirmed it creates nothing. Just call it when the picking screen opens and
tell staff when `parcelsCreated` is non-zero: a previously printed list now
needs printing again to include those households.

Generation is all-or-nothing. If any household holding a place has no model
parcel for its size, no new parcels are created; show the error and have an
administrator complete the household grid before trying again.

The session pick-list response identifies each household by name and says
whether it is a delivery, so the running screen can select a client and label
attendance accurately. It never carries the referral reason, address or phone.

**Contents are copied at generation.** Editing a model parcel afterwards cannot
change a list that already exists. That is deliberate — a picker's sheet must
not change while they are holding it.

### Editing

Lines can be changed while `draft` **and after `printed`**. The list locks only
on `confirm`. This matters: pickers discover shortages at the shelf, after the
sheet is printed.

`PUT /parcels/{id}/lines` with `quantity: 0` **removes** the line — that is how
"we had none" is recorded.

Before recording either attendance outcome, call `POST /parcels/{id}/review`.
The session list exposes `reviewedAt` on each parcel so it can distinguish a
pending review from a reviewed pick list.

### Divergence

`GET /pick-lists/{id}/divergence` reports households whose size changed and
referrals since cancelled. While a list is editable, opening it reconciles
newly booked households automatically; a confirmed list still reports them as
missing because it is locked.

No existing parcel is ever changed automatically. Show household-size changes
and cancelled referrals as warnings and let a human decide what to do.

`changedHouseholds` is reachable now that household counts are correctable
again: `was` is the snapshot the picker is packing to, `now` is the referral as
it currently stands. Correcting a referral from one adult to three does **not**
resize the parcel — rewriting it underneath somebody mid-pick is exactly what
the snapshot prevents — so this is the warning that lets a team leader edit the
parcel or leave it.

### Attendance

**This is where stock moves.** Not on confirm.

```
POST /api/v1/parcels/{id}/attendance   { "attendance": "attended" }
  → { attendance, stockMoved, alreadyRecorded }
```

- `attended` issues the parcel and decrements stock.
- `no_show` moves nothing — the parcel is unpacked and nothing was given away.

A delivery uses the same two values. _Delivered_ is `attended` and _not in_ is
`no_show`; label them for the driver if that reads better on the screen, but do
not expect a third or fourth state.

**Submitting twice is safe.** `alreadyRecorded: true` means it was already in
that state and stock did not move again. You do not need to disable the button,
though doing so is kinder.

**An outcome can be taken back while the session is open.** Submitting the
_other_ value puts the parcel's stock back and marks the household the other
way, and you can flip as often as needed. This is the only way to fix a mis-tap,
so offer it plainly — no confirmation dialogue is warranted for a tap that is
reversible.

**Confirming the session ends that.** After `POST /sessions/{sessionId}/confirm`
a change is a `409`. Disable the control rather than letting someone try, and
put the weight of the confirmation on the _session_ — that is the tap in this
app that cannot be taken back.

`POST /sessions/{sessionId}/confirm` closes the session, and refuses while anyone
is still `pending`, returning `details.pendingPickNumbers` — show those numbers
so the team lead knows who is missing. There is no override: everybody is marked
one way or the other before the session closes.

### How stock moves

**Two `movementType` values, and there will not quietly be a third** — they are a
`CHECK` constraint on a table that cannot be altered without a rebuild, and that
column has already been rebuilt three times by guessing.

| Value             | Written by                                                       |
| ----------------- | ---------------------------------------------------------------- |
| `opening_balance` | `POST /stock/take` — one per counted item, at the counted figure |
| `parcel_issued`   | attendance, when a household attends or a delivery lands         |

There is no shop, no donation, no wastage and no hand correction. The count on
the shelf next week is what the stock is, whatever happened to it in between.

**Rows are deleted in exactly two places**, and both are deliberate: a stock take
discards the counted item's rows before writing its new baseline, and taking an
attendance outcome back discards that parcel's. Nothing else removes them, and a
row is never edited.

Two things worth knowing when you build a report:

- **Nothing is ever returned to stock by a new movement.** There is no reversal
  row: taking an attendance outcome back deletes that parcel's rows instead, and
  anything else wrong on a shelf is put right by the next count.
- **A stock take's variance is not recorded anywhere.** The count replaces the
  item's rows with one `opening_balance` at the counted figure, so the difference
  between the count and what the system held is gone the moment it is saved.
  That is the charity's decision, not an omission — do not build a report that
  needs it.

---

## 5. Printing

`GET /pick-lists/{id}/print` returns one object per parcel, **lines already
ordered by shelf** so a picker walks the aisle once (`A1, A2, A10` — not
alphabetically). Render in the order given.

What is **on every sheet**: `pickNumber`, and `refereeFirstName` /
`refereeSurname`. The name used to be withheld on collections; it is now on all
of them, because the person carrying the bag has to hand it to somebody and a
number does not do that.

What is on a sheet **only when `isDelivery` is true**: `deliveryAddress`,
`deliveryPostcode` and `deliveryPhone` — and the word `DELIVERY`, which you
render. These are the referee's own details: a delivery never goes anywhere
else, so there is no second address to send on a referral or display on a form.
All three are `null` on a collection.

What is deliberately **not** on a sheet:

- **The reason for referral.** Never, not even for an admin. Sheets get carried
  round halls and left on tables.
- **The answers.** `dietaryNotes` is **gone** — it scanned four guessed
  snake_case keys, none of which is a key in the real form, so it would have
  become `null` the day the form shipped. The preferences belong on the
  maintenance screen instead; see below.

### Preferences on the maintenance screen

`Parcel.answers` (on `GET /sessions/{id}/pick-list` and `GET /pick-lists/{id}`)
carries the referral's **whole answers map**, unfiltered.

Which of those are preferences is yours to know — you own the form definition
and the `preference` flag on each question — so filter the map yourself. The
server holds no definition and will not guess; that guess is exactly what
`dietaryNotes` was. The map is empty once the referral's personal data has been
purged.

---

## 5c. The listener sheet

```
GET /api/v1/sessions/{sessionId}/listener-sheet
  → 200 { sessionId, households: [ { referralId, refereeFirstName,
                                     refereeSurname, reason, needsFuelHelp,
                                     answers } ] }
```

**One sheet for the whole session**, not one per household. A listener is handed
a single sheet and scans it for whoever is in front of them, so it comes ordered
by surname; a purged household sorts last.

Open to a **team leader**, and this is **the only place a team leader is given
the reason for referral**. Everywhere else it stays with administrators, and
`Referral.reasonId` is still absent for them — that rule has not been relaxed,
an exception has been carved out of it. Do not use this endpoint to populate a
referral screen.

**`reason` is the label, not the id** — the thing to print. It **survives a
purge**, because the reason sits outside the personal-data block so that
reporting still works once nobody is identifiable. A reason the charity has
since retired still appears, because the referral was made under it.

**Cause Details is yours to extract.** `answers` is the referral's dynamic
answers whole and unfiltered, and _Cause Details_ is one of them. The server
holds no form definition, so it does not know which key that is and will not
guess — the same reason `answers` comes through whole on a parcel.

The sheet is deliberately minimal: **no address, postcode, phone, date of birth
or anything about the referrer.** It ends up on paper in a hall. If a screen
needs more than these five fields, that is a conversation rather than a field to
add.

**Who is on it is an assumption**, flagged `x-assumed` against **Q26**: every
household holding a place appears — awaiting review, accepted and read alike —
and cancelled and rejected ones do not. If
your users expect to find somebody who cancelled, say so before building around
it.

---

## 5d. Text reminders and replies

The run-session screen gains a **Send SMS Reminders** button and a conversation
per household. Team leader or admin throughout, except the unmatched screen.

```
POST /api/v1/sessions/{sessionId}/sms-reminders   (no body)
  → { reminded, failed, alreadyReminded }
GET  /api/v1/sessions/{sessionId}/sms-summary
  → { unreadTotal, households: [{ referralId, reminderSentAt, messageCount, unreadCount }] }
GET  /api/v1/referrals/{id}/sms-messages          → the thread, both directions
POST /api/v1/referrals/{id}/sms-messages          { body }  → text them back
POST /api/v1/referrals/{id}/sms-messages/read     → mark that household read
GET  /api/v1/sms-messages/unmatched               admin only
POST /api/v1/sms-messages/{id}/read               admin only
```

### Sending

**Press it as often as you like.** A household already texted for that session
is skipped, so a second press reaches only households referred since the first —
and households whose first attempt failed. The response says which happened:
`reminded`, `failed`, `alreadyReminded`.

**A failure is not a reminder.** No number, a landline, or the provider refusing
it leaves the household unreminded and puts a `failure` message on their line.
The next press tries them again — so a permanently wrong number produces a
failure every time, which is the point: it is the food bank being told.

Show `failed` prominently. Those are households who do not know when to come.

**You do not compose the message.** Collections get date, time and place;
deliveries get date and the session's `deliveryTime` and no address. Both are
server-side, because the wording is a data-protection constraint — the provider
is given a phone number and nothing that identifies whose it is.

### The counts

Poll `sms-summary` while the screen is open; a few seconds is fine. There is no
push channel and deliberately so — a text reply is not second-critical, and a
socket per open screen is a new runtime dependency for a number that can be a
`GET`.

**Counts are inbound only** — replies and failures. Texting a household back
does not raise their count, because a count that went up when staff answered
would be counting your own work back at you. The thread shows both directions.

`unreadTotal` is the number to make prominent. Per household, highlight the
button whenever `unreadCount > 0`.

### Reading and replying

Expanding a household's line should fire `POST .../sms-messages/read`. That is
what marks them read; there is nothing further for the user to press. It is a
separate call from the `GET` on purpose — a `GET` that writes gets retried and
prefetched, and somebody's unread count would clear without anyone looking.

Only `household_reply` is ever unread. A `failure` arrives already read: it needs
to be visible, but nobody is waiting for an answer.

**A team lead sees these**, which is a deliberate exception to "a team lead is
not shown why someone was referred" — of the same kind as the listener sheet. A
household may text something as personal as their reason. The person running the
session is the one who can act on "running 20 minutes late" or "I can't lift the
bag", so they get it.

**What staff type is bound by the same rule as the reminder**: no name, no
address, nothing that says whose number it is. The server cannot enforce that on
free text. Put it on the screen.

### Unmatched replies (admin)

A reply is matched by phone number to the referral for the **soonest session
still to come**. A session already past is not a candidate, so a text the morning
after lands here instead. So does a wrong number, and so does somebody the food
bank has never heard of.

They are never dropped. `phone` is on every message, but here it is the only
thing to act on — there is no referral behind a loose reply to look the
household up by.

### Thirty days

**Every message is deleted thirty days after it arrives** — reminders, replies,
failures and unmatched alike, nightly and automatically. Do not build anything
that treats a thread as a permanent record, and do not offer an export that
implies one.

---

## 5a. Two guards you should enforce in the UI

Both are **new**, both are enforced server-side, and both are things the screen
should make impossible rather than let someone attempt and be refused. You have
the data for both already.

### A confirmed session is sealed

Once `session.status === 'confirmed'`, nothing on that session changes. Every
one of these is now a `409`:

| Call                                      | Was     | Now                        |
| ----------------------------------------- | ------- | -------------------------- |
| `PATCH /referrals/{id}` (any correction)  | allowed | `409` if session confirmed |
| `PATCH /referrals/{id}` (move to another) | allowed | `409` if session confirmed |
| `POST /referrals/{id}/cancel`             | allowed | `409` if session confirmed |

The move is the one that used to do real damage: it left the household recorded
against two sessions and changed the figures of a session already signed off.

**What the screen should do:** disable amend, move and cancel for any referral
whose session is confirmed. `Referral` carries `sessionId`, not the session's
status, so you need the session — which a referral screen almost always has
already, since it shows the date. **If that is awkward for you, say so and we
will add `sessionStatus` to the referral response**; it is a one-line change on
our side and we would rather do it than have you fetch a session per row.

### A session with households on it cannot be cancelled

`POST /api/v1/sessions/{id}/cancel` now returns `409` while anybody still holds
a place, with the count in `details.booked`:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Move or cancel the households on this session before cancelling the session itself",
    "details": { "booked": 12 }
  }
}
```

The households have to be moved or cancelled one at a time first. Cancelling the
session out from under them would leave families expecting food that nobody has
arranged.

**What the screen should do:** `Session` already carries `booked`, so disable
the cancel action whenever `booked > 0` and say why — ideally with a route to
the referral list for that session, since that is where the work is. `booked`
counts every referral holding a place — `pending_review`, `active` and
`reviewed`: a household awaiting review may still turn up, so it holds a place
and it blocks the cancel, and reading a referral changes nothing about it.

---

## 5b. The stock simplification — mostly shipped

**These four endpoints are gone. They now return `404`:**

```
POST /api/v1/stock/purchases         recording a shop
POST /api/v1/stock/adjustments       wastage, donations, hand corrections
POST /api/v1/stock/takes             open a stock take
POST /api/v1/stock/takes/{id}/counts
POST /api/v1/stock/takes/{id}/commit
GET  /api/v1/stock/takes             list past takes
```

In their place there is **one** endpoint, `POST /api/v1/stock/take`, defined in
`openapi.yaml`. The weekly count is now the single source of truth: for every
item in the body, whatever the ledger held is discarded and replaced by one
`opening_balance` at the counted figure.

The parts of the count screen that will catch you out:

- **Send only the items whose number changed.** An item left out is untouched.
  Sending unchanged rows deletes history the charity expects to keep.
- **A count of `0` is legitimate** and means the shelf is empty.
- **Repeating a save is safe** but it is last-write-wins, not apply-once.
- **The same `stockItemId` twice in one body is a `400`**, not a
  last-one-wins.

`GET /stock/levels`, `/stock/items`, `/stock/search` and item maintenance are
unchanged. **Levels can still be negative** — parcels go out between counts.

### Attendance is reversible until the session is confirmed

Shipped. Marking a household a no-show after marking them attended **deletes
that parcel's stock movements** and puts the goods back; marking them attended
again takes it again. Flip as often as needed — the level is always the sum of
what is actually on the shelf.

This is now the **only** way to fix a mis-tap, because the hand correction that
used to do it has been removed. So the UI should offer it: an outcome on an open
session is not a commitment.

`POST /sessions/{id}/confirm` is the point of no return. After it, changing an
outcome is a `409`. Disable the control there rather than letting someone try.

---

## 5e. The fuel help list

```
GET /api/v1/fuel-help-list
  → 200 { households: [ { referralId, sessionDate, refereeFirstName,
                          refereeSurname, refereeAddress, refereePostcode,
                          refereePhone, answers } ] }
```

**This is the whole of a `fuel_admin`'s application.** That role reaches this
and `GET /api/v1/auth/me` and nothing else — every other endpoint answers
`403`. Build it one screen, not a cut-down version of the staff app. An `admin`
can read it too, so the charity is not locked out when the usual person is away;
a `team_lead` cannot.

**The screen is meant to be pasted into Excel.** The people doing fuel work live
in a spreadsheet, and the charity would rather they pasted a list than retyped
one and got a phone number wrong. A plain table that copies cleanly beats
anything clever.

A household is listed when **all four** are true: they asked for help with fuel;
they were **given their parcel** (a delivery counts as attended); the session is
**confirmed**; and that session was **within the last fourteen dates, counting
today**. Ordered oldest session first, so the top of the list is what is about
to age out.

**Extract the pre-payment meter and permission-to-ring answers from `answers`.**
They are ordinary questions on the form you own, so the server does not know
which keys they are and will not guess — the same arrangement as _Cause Details_
on the listener sheet. **Nobody is filtered out on them.** A household who said
not to ring them is still listed, with their answer beside them, because the
decision belongs to the person about to make the call and not to the system.
Show that answer prominently; it is the whole reason it is there.

**A row is a referral, not a household.** Being fed twice in a fortnight is not
expected and nothing de-duplicates it, so a household who was would appear once
per session.

`sessionDate` is the session the **parcel was issued at**, which is not always
the session the referral currently points at — a referral moved after picking
keeps its parcel on the original session. Do not join it back to a referral's
own session and expect them to match.

**No reason for referral, no date of birth, no household counts, no delivery
flag.** None of them bears on a fuel bill. `refereePhone` is free text exactly
as the referrer typed it — it is **not** normalised, so format for display
rather than assuming a shape, and it may be `null`.

---

## 6. Errors

Every failure has the same shape:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "That session is full",
    "details": { "capacity": 25, "booked": 25 },
    "requestId": "9f2c…"
  }
}
```

`message` is safe to show a user — it never contains personal data. `requestId`
is also in the `x-request-id` header; quote it when reporting a problem.

| Status | Meaning                     | What the client should do               |
| ------ | --------------------------- | --------------------------------------- |
| `400`  | Validation failed           | Show field errors from `details.issues` |
| `401`  | No or expired token         | Refresh once, retry, else sign out      |
| `403`  | Not permitted for this role | Should not happen if the menu is right  |
| `404`  | No such thing               |                                         |
| `409`  | Wrong state                 | Show the message; it is meaningful      |
| `422`  | A rule forbids it           | Show the message; it is meaningful      |
| `429`  | Rate limited                | Back off, then retry                    |
| `500`  | A bug                       | Generic apology plus the `requestId`    |

`409` and `422` are the two worth reading carefully. They are not failures to
retry — they mean _the session is full_, _this list is confirmed_, _that reason
is no longer offered_. Their messages are written to be shown.

Validation errors name the field and the rule but **never echo the value**, so
you cannot render "you entered X" from the response. Keep your own copy of what
the user typed.

---

## 7. Things that will bite

**Times are Europe/London wall clock.** `startTime` is `"10:00"` and stays
`"10:00"` across the BST changeover. `startsAtUtc` is the derived instant — sort
and filter on that, display the wall clock. Never send `startsAtUtc`; the server
derives it.

**Capacity counts households, not people.** A session of 25 takes 25 referrals
whatever their sizes. A staff `Session` carries `booked` alongside `capacity`, so
`booked / capacity` is the occupancy — and **`booked` can exceed `capacity`**,
because an admin may deliberately overfill a session when moving someone. Do not
render that as an error. The public list omits both fields and simply excludes
anything full.

**A referral needs at least one adult.** The household grid starts at one adult,
so `adults: 0` is rejected.

**Households larger than 5 adults or 5 children clamp** into the corner of the
grid. A household of nine gets the same parcel as five.

**Stock levels can be negative** after a correction. Do not assume non-negative.

**Rate limiting is per IP**, roughly five referral submissions and sixty other
public calls a minute. Normal use never approaches it; a retry loop will.
