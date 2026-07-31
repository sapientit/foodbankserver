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

The `role` in that response is what you choose the menu from — `admin` or
`team_lead`.

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

Two roles. Use them for menus; **never for access control.**

|                                                 | `admin` | `team_lead` |
| ----------------------------------------------- | ------- | ----------- |
| Run a session: pick lists, printing, attendance | ✅      | ✅          |
| Read sessions, stock, referrals, model parcels  | ✅      | ✅          |
| See the session list more than six days ahead   | ✅      | ❌          |
| Shops, stock takes, stock corrections           | ✅      | ✅          |
| Create or amend sessions and referrals          | ✅      | ❌          |
| Maintain the stock item list                    | ✅      | ❌          |
| Model parcels and the household grid            | ✅      | ❌          |
| Referrers and reasons for referral              | ✅      | ❌          |
| User maintenance                                | ✅      | ❌          |
| **See why someone was referred**                | ✅      | ❌          |

The server re-checks the role on every request from the signed token. If someone
edits `role` in your app's state they will see extra menu items and get `403` on
every one of them — harmless, but show the right menu anyway.

### Field-level visibility

A **team lead does not receive** `reasonId`, `referrerEmail` or `referrerPhone`
on a referral. The fields are absent, not null. Treat them as optional in your
types — `openapi-typescript` already will.

Why: the reason for referral is the most sensitive thing in the system. It can
mean financial hardship, domestic abuse, or immigration status. A picker needs
household size, not that.

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

**Not capped:** `GET /api/v1/sessions/{id}` and every pick-list route. A team
lead holding a session id can still open it and its pick list however far out
it is. That is Q14 in `OPEN-QUESTIONS.md` and unsettled — do not build a
screen that relies on either reading.

---

## 3. The public referral flow

Unauthenticated, and the only open write in the system. Rate limited per IP.

```
1  GET  /api/v1/public/sessions           which sessions have space
2  POST /api/v1/public/referrers/check    is this address allowed to refer?
3  GET  /api/v1/public/referral-reasons   the reason dropdown
4  POST /api/v1/public/referrals          submit  → returns editKey ONCE
```

Call step 2 as the referrer types their address, so an unauthorised one is
caught before they fill in a whole form.

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

The reason dropdown (step 3) is the exception that stays server-side: it is a
maintained lookup, admin-editable, and the referral points at one by `reasonId`.

**After a retention purge, `answers` comes back empty** along with the
identifying fields — the server cannot tell which answers were personal, so it
drops all of them.

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

### The edit key

The submission response contains `editKey`, **once and nowhere else**. It lets
the referrer amend or withdraw _that one referral_ for fifteen minutes:

```
GET|PATCH|DELETE /api/v1/public/referrals/{id}
  header: x-referral-key: <editKey>
```

Four things to build around:

- **Fifteen minutes from submission, absolute.** Amending does not extend it.
  Show a countdown, and hide the edit UI when it lapses.
- **Amending does not return a new key.** Keep the original.
- **`DELETE` consumes it.** After withdrawing, the key is dead.
- After expiry the referrer has no self-service route and must phone the food
  bank. Say so in the UI; a `409` here is not an error to apologise for.

Hold the key in memory. It authorises access to somebody's name and address, so
it does not belong in a URL, `localStorage`, or anywhere it could be shared or
logged.

---

## 4. Running a session

```
POST /api/v1/sessions/{sessionId}/pick-list     generate (or fetch)
GET  /api/v1/pick-lists/{id}/print              one sheet per parcel
POST /api/v1/pick-lists/{id}/print              mark printed
     …pick, adjusting lines as stock runs out…
POST /api/v1/pick-lists/{id}/confirm            lock the list
     …the session happens…
POST /api/v1/parcels/{id}/attendance            per household
POST /api/v1/sessions/{sessionId}/confirm       close the session
```

### Generating

Generated on first view. `POST` is idempotent — calling it again returns the
existing list with `parcelsCreated: 0`. Just call it when the picking screen
opens.

`skipped` lists any referral with no model parcel for its household size. The
rest are still picked; show these as a warning so an admin can fix the grid.

**Contents are copied at generation.** Editing a model parcel afterwards cannot
change a list that already exists. That is deliberate — a picker's sheet must
not change while they are holding it.

### Editing

Lines can be changed while `draft` **and after `printed`**. The list locks only
on `confirm`. This matters: pickers discover shortages at the shelf, after the
sheet is printed.

`PUT /parcels/{id}/lines` with `quantity: 0` **removes** the line — that is how
"we had none" is recorded.

### Divergence

`GET /pick-lists/{id}/divergence` reports referrals that arrived after
generation, households whose size changed, and referrals since cancelled.

Nothing is applied automatically. Show it as a warning and let a human decide —
there is currently no endpoint that syncs late referrals in, so those are handled
by hand.

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

**The outcome is final.** Submitting the _other_ value afterwards is refused with
`409` — a confirmed collection or delivery cannot be undone. Putting a mis-tap
right is a stock adjustment (`POST /stock/adjustments`, which a team lead may
also do). Surface that message rather than swallowing it, and confirm before
sending in the first place: this is the one tap in the app that cannot be taken
back.

`POST /sessions/{sessionId}/confirm` closes the session, and refuses while anyone
is still `pending`, returning `details.pendingPickNumbers` — show those numbers
so the team lead knows who is missing. There is no override: everybody is marked
one way or the other before the session closes.

### How stock moves

Six `movementType` values, and there will not quietly be a seventh — they are a
`CHECK` constraint on a table that cannot be altered without a rebuild.

| Value             | Written by                                               |
| ----------------- | -------------------------------------------------------- |
| `opening_balance` | a hand adjustment, when an item first goes on the list   |
| `purchase`        | `POST /stock/purchases` — a shop                         |
| `donation`        | a hand adjustment                                        |
| `parcel_issued`   | attendance, when a household attends or a delivery lands |
| `wastage`         | a hand adjustment — anything thrown away, for any reason |
| `correction`      | a hand adjustment, and a stock take's variance           |

`POST /stock/adjustments` accepts **all six**, not just the hand-typed four:
stock arriving without a recorded shop, or a parcel handed over outside a
session, both happen in a warehouse. Every adjustment requires a `reason`.

Two things worth knowing when you build a report:

- **Nothing is ever returned to stock.** There is no reversal movement. A parcel
  that has been issued stays issued and a mistake becomes a `correction`.
- **A stock take's variance is a `correction`** carrying that stock take's id, so
  you can still find it — but the movement type alone will not separate it from a
  team lead's hand correction. Whether it should is **Q13** in
  `OPEN-QUESTIONS.md`, so do not build a report that depends on the answer yet.

---

## 5. Printing

`GET /pick-lists/{id}/print` returns one object per parcel, **lines already
ordered by shelf** so a picker walks the aisle once (`A1, A2, A10` — not
alphabetically). Render in the order given.

What is deliberately **not** on a sheet:

- **The reason for referral.** Never, not even for an admin. Sheets get carried
  round halls and left on tables.
- **Name and address**, unless `isDelivery` is true — where the address is the
  entire point. `deliveryAddress` on a print sheet is the referee's own address:
  a delivery never goes anywhere else, so there is no second address to send on
  a referral or to display on a form.

What **is** there: `dietaryNotes`, because the picker is the only person who can
act on them, and the alternative is a parcel that cannot be eaten. Show them
prominently.

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
