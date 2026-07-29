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

**Two rules about the tokens.**

Hold the access token **in memory only**. Not `localStorage`, not a cookie you
set yourself. It lasts fifteen minutes; losing it on a page reload is fine
because refresh recovers it.

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

**Refresh exactly once per failure, and never in parallel.** Each refresh
rotates the token. If two requests 401 at the same moment and both refresh, the
second presents a token the first already rotated, and the server treats that as
theft: it **revokes the entire family** and signs the user out everywhere. Queue
concurrent 401s behind a single in-flight refresh.

On reload, call `GET /api/v1/auth/me` to rebuild UI state from the cookie.

### What changes when Google auth arrives

The response shape does not. What changes is that **an unknown email is
rejected** rather than silently creating an admin, which is what the development
login does today. Build against the rejection: a valid Google identity that is
not a known user gets `401`, with the same message as a bad credential.

---

## 2. Roles

Two roles. Use them for menus; **never for access control.**

|                                                 | `admin` | `team_lead` |
| ----------------------------------------------- | ------- | ----------- |
| Run a session: pick lists, printing, attendance | ✅      | ✅          |
| Read sessions, stock, referrals, model parcels  | ✅      | ✅          |
| Create or amend sessions and referrals          | ✅      | ❌          |
| Stock maintenance, shops, stock takes           | ✅      | ❌          |
| Model parcels and the household grid            | ✅      | ❌          |
| Referrers, reasons, form definitions            | ✅      | ❌          |
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

---

## 3. The public referral flow

Unauthenticated, and the only open write in the system. Rate limited per IP.

```
1  GET  /api/v1/public/sessions          which sessions have space
2  POST /api/v1/public/referrers/check   is this address allowed to refer?
3  GET  /api/v1/public/referral-form     the questions and reason options
4  POST /api/v1/public/referrals         submit  → returns editKey ONCE
```

Call step 2 as the referrer types their address, so an unauthorised one is
caught before they fill in a whole form.

Step 3 returns the questions as data — render them dynamically. The form changes
periodically and the answers you send back are keyed by each question's `key`.

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

**Submitting twice is safe.** `alreadyRecorded: true` means it was already in
that state and stock did not move again. You do not need to disable the button,
though doing so is kinder.

A mistake can be corrected **once in each direction** — attended → no-show
returns the stock. A third change is refused with `409` and needs an admin stock
adjustment. Surface that message rather than swallowing it.

`POST /sessions/{sessionId}/confirm` refuses while anyone is still `pending`, and
returns `details.pendingPickNumbers` — show those numbers so the team lead knows
who is missing.

---

## 5. Printing

`GET /pick-lists/{id}/print` returns one object per parcel, **lines already
ordered by shelf** so a picker walks the aisle once (`A1, A2, A10` — not
alphabetically). Render in the order given.

What is deliberately **not** on a sheet:

- **The reason for referral.** Never, not even for an admin. Sheets get carried
  round halls and left on tables.
- **Name and address**, unless `isDelivery` is true — where the address is the
  entire point.

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
whatever their sizes.

**A referral needs at least one adult.** The household grid starts at one adult,
so `adults: 0` is rejected.

**Households larger than 5 adults or 5 children clamp** into the corner of the
grid. A household of nine gets the same parcel as five.

**Stock levels can be negative** after a correction. Do not assume non-negative.

**Rate limiting is per IP**, roughly five referral submissions and sixty other
public calls a minute. Normal use never approaches it; a retry loop will.
