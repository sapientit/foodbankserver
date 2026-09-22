# Food Bank API — client guide

Everything a frontend needs that a schema cannot express. The shapes live in
[`openapi.yaml`](./openapi.yaml); this covers the sequences, the rules about who
sees what, and the handful of things that will otherwise be got wrong.

Base path is `/api/v1`. Everything is JSON. There is no HTML, no server-side
rendering and no PDF — printing and layout are the client's.

## Where the server is

|            | URL                                              |
| ---------- | ------------------------------------------------ |
| Local      | `http://127.0.0.1:8787`                          |
| Test       | `https://api-test.guildfordfoodbank.workers.dev` |
| Production | not yet deployed                                 |

`/health` and `/ready` sit at the **root**, not under `/api/v1`. Everything else
is under the base path.

`/health`'s `version` is the deployed commit's git SHA, stamped by `npm run
deploy`/`deploy:test`. `null` normally means the Worker was not deployed that
way — local dev, CI's dry run, or a manual `wrangler deploy` that skipped the
stamp — rather than proof nothing real is running; there is no server-side
guarantee tying the two together. Compare it against what you expect to have
deployed if a release ever looks like it did not take.

The test system runs dummy authentication, so anyone who knows a seeded address
is an admin. **Never put real personal data in it.** The seeded address is
deliberately not written down here — ask Pete for it.

### Why the browser must not call this host directly

The refresh cookie is `SameSite=Strict`, and browsers decide "same site" from the
Public Suffix List — on which **both `workers.dev` and `pages.dev` appear**. A
client on its own `*.workers.dev` or `*.pages.dev` host is therefore cross-site
from this API, the browser silently drops the cookie, and the session dies
fifteen minutes after login looking exactly like an auth bug. It is not one.

**The agreed arrangement avoids this**: the client Worker serves the app and
forwards `/api/v1/**` to this Worker over a Cloudflare **service binding**, so
the browser only ever talks to one origin. Nothing is cross-origin, no preflight
happens, and `ALLOWED_ORIGINS` stays empty — which is what `src/http/cors.ts`
already calls the correct same-origin default. There is nothing to configure
here.

### What the proxy must get right

Four requirements. Each fails quietly, and two of them fail as something that
looks like a server bug.

**1. Forward the original `Request`, so `cf-connecting-ip` survives.** This API
reads that header in two places: the rate limiter's bucket key
(`http/middleware/rate-limit.ts`) and Turnstile's `remoteip` on siteverify
(`modules/referrals/public.routes.ts`). Building a fresh `Request` without
copying headers drops it, the limiter falls back to a single literal key, and
**every visitor on earth shares one bucket** — at which point `REFERRAL_LIMITER`
throttles the entire public referral form to five submissions a minute. Pass the
request through (`env.API.fetch(request)`), or copy the header explicitly.

**2. Proxy path-for-path.** The refresh cookie is scoped to
`path=/api/v1/auth`. If the client mounts the API anywhere else — `/backend/**`,
`/proxy/**`, anything rewritten — the browser will not match the path and will
never send the cookie back, producing the same fifteen-minute death this
arrangement exists to prevent. Browser `/api/v1/**` must arrive here as
`/api/v1/**`.

**3. Return the response with its headers intact**, `Set-Cookie` above all. A
proxy that constructs a new `Response` from just the body and status silently
discards the refresh cookie, and login appears to succeed while nothing persists.

**4. Forward `authorization` and `cf-turnstile-response`.** The first carries
every authenticated call; the second is how the referral form passes its
Turnstile token.

`/health` and `/ready` are at the **root**, not under `/api/v1`, so they are
outside the proxied prefix. Route them separately if you want them, and mind the
collision if the client Worker has a `/health` of its own.

**Worth verifying once, from two networks.** Trip the referral limiter from one
device (six or more submissions inside a minute) and check a second device on a
different connection — mobile data, say — is unaffected. If the second is also
throttled, `cf-connecting-ip` is not reaching this API and requirement 1 is
broken. It is a two-minute test that catches the one failure here that would
otherwise be found by a referrer unable to submit.

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

### One credential that is not a sign-in

A team lead can hand a volunteer a code to count the stock with, so somebody
with no account can do the weekly stock take. It is a header, not a token, it
reaches the stock take and nothing else, and it lapses after fourteen days. See
§4, "Counting the stock without an account".

---

## 2. Roles

Three roles. Use them for menus; **never for access control.**

|                                                          | `admin` | `team_lead` | `fuel_admin` |
| -------------------------------------------------------- | ------- | ----------- | ------------ |
| Run a session: pick lists, printing, attendance          | ✅      | ✅          | ❌           |
| Read sessions, stock, referrals                          | ✅      | ✅          | ❌           |
| See the session list more than six days ahead            | ✅      | ❌          | ❌           |
| The weekly stock take                                    | ✅      | ✅          | ❌           |
| Create or amend sessions and referrals                   | ✅      | ❌          | ❌           |
| Maintain the stock item list                             | ✅      | ❌          | ❌           |
| Model parcels and the household grid (**incl. reading**) | ✅      | ❌          | ❌           |
| Target stock lists: maintain (create / amend / delete)   | ✅      | ❌          | ❌           |
| Target stock lists: read                                 | ✅      | ✅          | ❌           |
| Referrers and reasons for referral                       | ✅      | ❌          | ❌           |
| User maintenance                                         | ✅      | ❌          | ❌           |
| **See why someone was referred**                         | ✅      | ❌          | ❌           |
| **The fuel help list**                                   | ✅      | ❌          | ✅           |

**`fuel_admin` is not a lesser `admin`, and a menu built by subtracting from
one will be wrong for it.** It reaches `GET /api/v1/fuel-help-list` and
`GET /api/v1/auth/me` and nothing else at all — every other endpoint answers
`403`. Its whole screen is one list. See §5e.

**`GET /api/v1/target-stock-lists` is the one maintenance resource a team lead
can read, settled 2026-08-31 (was Q48).** Everything else that says "admin
only" above means admin only for reading too — model parcels above all, which
this otherwise resembles, and precisely because "a team lead having no reason
to see this" turned out to matter there. Target stock lists are different: a
team lead already counts the shelves each week and stands in the stock room,
so a target figure for an item — even one already well stocked — tells them
nothing a walk around would not. Do not build a menu or guard on "team lead =
admin minus the maintenance screens" from this row either way — that already
got this resource backwards once, and reads that way in reverse just as
easily.

The server re-checks the role on every request from the signed token. If someone
edits `role` in your app's state they will see extra menu items and get `403` on
every one of them — harmless, but show the right menu anyway.

### Field-level visibility

A **team lead does not receive** `reasonId`, `referrerEmail`, `referrerPhone`,
`reviewComment`, `adminInfo` or `firstTimeReview` on a referral. The fields are
absent, not null. Treat them as optional in your types — `openapi-typescript`
already will. `firstTimeReview` is new — see **5j** — and a team lead's
equivalent is the dateless `Parcel.firstTimeMarker` on a pick list, not a
thinner version of this field.

Why: the reason for referral is the most sensitive thing in the system. It can
mean financial hardship, domestic abuse, or immigration status. A picker needs
household size, not that. `reviewComment` is withheld for the same kind of
reason — it can name a referrer or record a suspicion about one.

**`adminInfo` is narrower than admin-only.** It is the administrators' own
free-text note about the household, and it is on responses that carry **one**
referral: `GET /referrals/{id}`, `PATCH /referrals/{id}`, and the accept,
reject, review, cancel and copy routes. It is **absent from the `GET /referrals`
list rows for an administrator too**, so do not build a list column from it —
open the referral.

**`outcome` is optional for a different reason and is not admin-only.** A team
lead receives it. It is on the same one-referral responses as `adminInfo` and
absent from the list rows, but because deriving it costs a query rather than
because anybody is being withheld from — see "A referral now says what became of
the household".

**`POST /referrals/search` is the single exception**, settled by the charity on
2026-08-15: a search result row carries `adminInfo`, and it is the only response
carrying more than one referral that does. The reason is that screen's whole
purpose — an administrator on the phone to a household wants what the office
learned the last time it rang them at the same moment it wants the causes. On
that row it is `string | null` and always present, not optional: the endpoint is
admin-only outright, a team lead gets a `403` rather than a thinner row, so
`null` means there is no note and nothing else.

Apart from that one row it is on nothing else at all: not the repeat-referral
list, not the listener sheet, the referral-details list, the pick list, the fuel
help list, an SMS payload or the spreadsheet extract. Do not read the search
exception as permission to put the note on any of them.

A team lead also **does not see rejected referrals at all**. They are missing
from `GET /referrals` whatever you filter by (`status=rejected` returns an empty
list rather than an error), and `GET /referrals/{id}` on one is a `404`. Pending
referrals they do see, marked by `status`: the household may well turn up, and
the team lead is the person in the hall when they do.

### How far ahead each role sees

`GET /api/v1/sessions` returns a different window depending on who asks:

| Caller                      | Window                                           |
| --------------------------- | ------------------------------------------------ |
| `admin`                     | everything materialised — six weeks              |
| `team_lead`                 | today → today + 6 days, inclusive                |
| nobody (`/public/sessions`) | the booking cutoff → today + 14 days, with space |

Counted in `Europe/London`, so the window turns over at London midnight, not at
`00:00Z`.

**The booking cutoff is 16:00 the day before a session.** So the public list's
near end is tomorrow up to and including 16:00 today, and the day after tomorrow
from 16:01; 16:00 itself still makes the deadline, and today's sessions are
never offered. The far end stays 14 days from today, so the list shortens over
the afternoon rather than sliding forward.

**`POST /public/referrals` now enforces the same cutoff**, refusing a session
that has closed for booking with `409` — reversing the earlier position that
only the list applied it. The clock is read at the moment of submission, not
when the form was loaded, so a session still listed here when the referrer
opened the form can still be refused if they submit after 16:00. Do not
re-check the clock in the client and do not filter the list further; submit
whatever session the referrer chose and let the server decide. Settled by
Pete on 2026-08-19.

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
of them. `adminInfo` goes with them. The referrer's name, email and phone
survive, as does `reviewComment`: the point of the purge is to stop holding the
household's details, not to lose track of who referred them or of why a referral
was accepted. The note about the household is the one administrator-written
field that does not survive, because it describes the people rather than a
decision.

### The postcode has a settled form, and you apply it too

**This is a rule both repos implement, not a server behaviour you consume.** It
is written down here because it has to be the same at both ends, and because
neither of us can see the other's code.

The review screen matches a household against earlier referrals on date of
birth, postcode and phone number, so `gu14aa` and `GU1 4AA` have to be the same
postcode. Turning one into the other is the **settled form**:

1. Uppercase it and remove every whitespace character.
2. Keep the result only if it matches
   `^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$`. If it does not, there is no
   settled form for that postcode.
3. To **display** it, put a single space before the final three characters:
   `GU14AA` → `GU1 4AA`.

**Do it in the form, as the referrer types.** That is the better place for it,
because you can show them what has been understood while they can still correct
it. The server does it again when the referral arrives, and stores the result
in a column of its own — a referral can reach the food bank by routes that never
went through your form, and matching cannot assume every one of them tidied up
first. Doing it twice is deliberate.

Three things that follow, and they matter:

- **Normalising is not validating.** A postcode the rule cannot make sense of
  does not stop the referral. It is taken, stored exactly as typed, and simply
  never matched on. **Do not reject the submission** — the charity would rather
  look at a referral with an odd postcode on it than turn away a household over
  the way an address was written down.
- **The stored value is what the referrer wrote**, not the settled form.
  `refereePostcode` comes back on every response exactly as it was sent; putting
  a value into a settled form never rewrites the value itself. If your form
  normalises the text in the input box, that is what gets sent and that is what
  is stored — which is fine, and is why showing the display form matters.
- **The same holds for the phone number**, on the server side only. It is put
  into UK E.164 (`+447700900123`) for matching, from `07700 900123`,
  `+44 7700 900123` or `(07700) 900-123` alike. Anything that is not a UK
  number has no settled form and is not matched on. Nothing is asked of your
  form here; the number is stored as typed either way.

### A session has a numeric delivery capacity

`Session` and `RecurringSession` carry **`deliveryCapacity`**: how many of the
session's overall `capacity` may be deliveries. Zero means that session has
nobody to drive, and it can never exceed `capacity` — the API rejects a create
or patch that would let it. `PublicSession` does not carry the number itself;
it carries **`deliveryAvailability`**, one of `not_offered`, `full` or
`available`, so the unauthenticated list never leaks a raw capacity or booked
count.

**`POST /public/referrals` refuses a delivery outright once a session's
`deliveryAvailability` is anything other than `available`** — a `409`, the
same hard stop as a session at its overall capacity. A collection is never
affected, however full delivery is. This replaces the boolean
`deliveriesAllowed` this file used to describe here, which the form and
server both left unenforced; that is no longer the case. Settled by Pete on
2026-08-19.

### `collectionMethod` replaces `isDelivery` as input — breaking

`ReferralSubmission` and `ReferralAmend` no longer accept `isDelivery`.
**Send `collectionMethod` instead** — `'collection'`, `'delivery'` or
`'referrer_collect'` — required on submission, optional on amendment like
every other field there. It is now the sole source of truth for whether a
parcel is a delivery; there is no longer a separate flag for the two to
disagree on.

`referrer_collect` is new: **the referrer, not the referee, is coming to
collect the parcel.** It counts as a collection everywhere delivery capacity,
the driver's round or the delivery address matter — a session's
`deliveryAvailability` never sees it, and it goes out at the session the same
as an ordinary collection. What changes is who a parcel-related text message
goes to; see "Referrer collection and SMS" under §5d.

`isDelivery` still comes back on every referral response, `ReferralReceipt`
included — derived (`true` only for `collectionMethod: 'delivery'`), read-only,
kept for anything that only cares whether a parcel is a delivery and does not
need to tell `collection` from `referrer_collect` apart.

A referral submitted before this shipped has its `collectionMethod` read
across from whatever `isDelivery` used to say — `delivery` where that was
`true`, `collection` where it was not. Nothing already held can say whether a
referrer was collecting, so no existing referral is ever `referrer_collect`.

### `referrerPhone` is now required — breaking

`ReferralSubmission.referrerPhone` is required on **every** referral, not only
a `referrer_collect` one — the food bank may need to ring the person who sent
a household regardless of how the parcel itself is collected. It was
previously optional; omitting it is now a `400`.

### A session's delivery window

A delivery is promised for a **window**, not a moment. A van cannot arrive at
13:00, and a household told it would waits at the door and then rings up. So a
session carries a start and an end, and **the two move together** — sending one
without the other, or an end at or before the start, is a `400`. A session that
sets no window of its own delivers across the session's own hours.

The two responses differ on purpose:

- **`Session`** and **`RecurringSession`** carry the **stored** pair,
  `deliveryWindowStart` and `deliveryWindowEnd`, either both `HH:MM` London or
  both `null`. Null is what lets a maintenance screen show "not set" and offer
  to clear it — `PATCH` with explicit `null` on both does that.
- **`PublicSession`** carries the **effective** window, and **never null**: the
  fallback to the session's own hours is already resolved server-side, so the
  referral form has a window to state without re-deriving that rule.

`PublicSession` is the narrowest response in the API and this widened it
deliberately, because the form now asks the referrer to confirm the client will
be at home for the window and cannot ask that without saying what it is. A
window is a fact about a session, not about a household.

**Nothing is scheduled or routed from it**, which is why there is no
`deliversAtUtc` beside it — it is a window to show and to put in a text message,
and the driver's round is still made up from the addresses on the referrals.

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

### Has this household been here before? (admin only)

A food bank parcel is emergency support, not a way of living. A household coming
back again and again is a sign the emergency was never resolved, and the
administrator reviewing the referral is the person who should see that. So the
review screen carries a count, and a button behind it.

`GET /api/v1/referrals/{id}` gains, **for an administrator only**:

```json
"repeatReferrals": { "count": 3, "mostRecentSessionDate": "2026-08-11" }
```

`GET /api/v1/referrals/{id}/repeat-referrals` is the button — admin only, and
the only place another household's details are returned:

```json
{
  "count": 3,
  "mostRecentSessionDate": "2026-08-11",
  "matches": [
    {
      "referralId": "…",
      "sessionId": "…",
      "sessionDate": "2026-08-11",
      "outcome": "booked",
      "matchedOn": ["postcode", "phone"],
      "refereeFirstName": "…",
      "refereeSurname": "…",
      "refereeDateOfBirth": "1990-03-02",
      "refereeAddress": "…",
      "refereePostcode": "…",
      "refereePhone": "…"
    }
  ]
}
```

Ordered most recent session first. `outcome` is `attended`, `no_show` or
`booked`; `matchedOn` is a non-empty subset of `date_of_birth`, `postcode` and
`phone`.

Six things to build around:

- **`matches` stops at 50 and `count` does not.** When `count` is larger there
  are more, and there is no page two to ask for. **Render both numbers when
  they differ** — "50 of 312" — because a screen showing only the rows tells an
  administrator that fifty is all there is, which is the one thing this must
  not do. It is a postcode shared by a hostel or a refuge that produces numbers
  like that, and past fifty nobody reads on anyway; the honest answer there is
  the count with a sample of it, not three hundred names on a page.

- **`mostRecentSessionDate` can be in the future.** It is the date of the
  session the referral is on, not a date the household was fed — so a household
  booked in for next Tuesday reports next Tuesday. Do not label it "last
  attended" or format it as a past date. `null` when `count` is 0.
- **The count is referrals, not parcels.** Everything except a cancelled or
  rejected referral counts: fed, did not turn up, and still to come alike. That
  is deliberate and it is the point — a household referred to two sessions in the
  same week is exactly what this exists to catch, and counting only parcels
  handed over would hide the second one until after it had been picked, packed
  and given out. `outcome` on each row is how the administrator tells food given
  from places booked; show it.
- **Do not fetch the list to render the count.** The summary is on the referral
  you already have. The button is a second call because it returns other
  households' names, addresses, phone numbers and dates of birth, and those
  should not cross the wire until an administrator asks for them.
- **`matchedOn` is not decoration.** A match on all three is almost certainly the
  same household; a match on postcode alone may be two families in one block of
  flats, a hostel or a refuge — which is exactly the housing these households
  live in. Show which it was, or the number becomes one an administrator learns
  to ignore.
- **Nothing is blocked, and you must not add a block.** No refusal, no warning
  banner, no "are you sure". The administrator is shown what was found and makes
  the call; a rule that turned a household away on the strength of a shared
  postcode would be the wrong kind of help. The charity was explicit about this.

The lookback is fifteen months, counted from when each referral was made — the
same clock the retention purge runs on, so a household whose details have been
forgotten cannot be found. That is accepted, not a bug: there is nothing left to
match on.

#### The `Exclude postcode matches` checkbox

```
GET /api/v1/referrals/{id}/repeat-referrals?excludePostcode=true
```

Beside the count, unticked to start with. Ticked, it matches on **date of birth
and phone number only**. A shared postcode in a hostel or a refuge is useful to
see by default and useless once you have seen it, and this is how an
administrator takes it out of the calculation without touching the referral.

**Re-fetch and use all three values it returns** — `count`,
`mostRecentSessionDate` and `matches` are all recalculated. Do not filter the
rows you already hold: you would leave the count saying one thing and the list
showing another, which is the specific confusion this checkbox exists to remove.
`matchedOn` can then only contain `date_of_birth` and `phone`.

A household with neither a date of birth nor a usable phone number on file comes
back empty rather than matching everybody. Nothing is remembered — it is a way
of looking, not a correction, and reloading the referral starts unticked again.

Send the string `true` or `false`; anything else is a `400`.

### Finding a referral when somebody rings (admin only)

```
POST /api/v1/referrals/search
{ "postcode": "GU23 4XX", "phone": "01483 123456", "dateOfBirth": "1980-01-31" }
  → 200 { count, results: [ … at most 50 … ] }
```

**A `POST` with a body, deliberately.** A `GET` would put a postcode and a phone
number in the URL, where they reach access logs, browser history and `Referer`
headers. Nothing in this system puts personal data in a URL. Do not convert this
to query parameters and do not build a bookmarkable search link.

**At least one of date of birth, postcode and phone number; none is a `400`.**
They are the same three identifiers the duplicate count matches on, settled by
the same rule — so you do not need to normalise anything before sending it, and a
value the rule cannot read is quietly not searched on rather than refused. A
search whose only value is unrecognisable returns `count: 0`. `surnamePrefix` is
an optional case-insensitive narrowing filter applied after the identifier match;
it cannot be supplied alone.

**More than one identifier widens the search.** Any one matching is enough. Say
so on the screen if you offer more than one box, because people assume the
opposite — somebody ringing up gives the details they have and often has one of
them slightly wrong, and a search insisting they all agree would fail exactly
when it was needed.

**Cancelled and rejected referrals are searchable and returned**, and there is
no fifteen-month window here — unlike the duplicate count. A referral whose
details have been purged cannot be found, because the purge nulls the columns
this searches on.

**The results are the administrator's working list**: session date, status,
first name, surname, postcode, phone number, the main reason id, the referrer's
name and organisation, `answers` whole, and `adminInfo`. Resolve `reasonId`
using the admin-only referral-reasons lookup, including retired reasons.

**`adminInfo` is here and nowhere else that carries more than one referral.**
The administrators' own note about the household rides the search row by the
charity's decision of 2026-08-15 — see _Field-level visibility_ above for the
rule and the reason. It is `string | null` and always present, because this
endpoint is admin-only outright, so `null` is "no note" rather than "not for
you".

**`referrerOrganisation` is the one field here that is never null.** It is
`NOT NULL` on the table and outside the PII block, so it survives the purge —
though a purged referral cannot be found by this search anyway, since the purge
nulls the columns it matches on. `referrerName` is unchanged and still returned
beside it.

**The secondary cause and the additional crisis detail are yours to extract.**
They are answers, not columns, and `answers` comes through whole and unfiltered
— the same arrangement as _Cause Details_ on the listener sheet, and for the
same reason: the server holds no form definition, so it does not know which keys
they are and will not guess. The whole blob belongs to you.

The response does not contain the date of birth, the address, the review
comment, the referrer email or the referrer phone, and the client must not fetch
each result's full detail to reconstruct those omitted fields.

`count` is uncapped and `results` holds at most 50, newest session first. Show
both numbers when they differ — there is no paging, and the answer to a count of
two hundred is a narrower search.

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
adults             children           collectionMethod   needsFuelHelp
reasonId           answers            adminInfo (nullable)
sessionId (a move)
```

A referrer who mistypes an address, or a household that moves between being
referred and being fed, has to be correctable — a delivery goes to the address on
the referral, so a wrong one there is a parcel on the wrong doorstep. **A full
referral edit form is the right shape again.**

**Send only what changed.** Every field is optional and an omitted one is left
alone, so a one-field correction is a one-field request. `answers` is the
exception and still **replaces** the stored set outright rather than merging —
you hold the form, so a key you leave out has been removed.

**`adminInfo` is the administrators' own note, and it is not an answer.** Send a
string to set it (trimmed, at most 2000 characters), explicit `null` to clear
it, or omit it to leave it alone. **An empty string is a `400`** — send `null`
instead. It has its own field precisely because `answers` is replaced
wholesale: when an administrator saves one page of the form you send the
complete preserved answers map, and the note must not vanish with a page that
never held it. Include `adminInfo` in that same `PATCH` when the note changed;
leave the key out when it did not.

**The referrer's own details are still refused**: `referrerName`,
`referrerPhone`, `referrerOrganisation` and above all `referrerEmail`, which is
what the accept-or-hold decision was made on. The body is strict, so sending one
is a `400` naming it rather than a `200` that silently changed nothing.

**There is no undo and no history.** A correction overwrites, and nothing keeps
what the field used to say. That is deliberate: a record of every change made to
a vulnerable household's details would be a second store of sensitive
information to look after and eventually delete, and the charity does not want
one. So there is nothing to show as "previously", and no way to recover a value
typed over. Confirm corrections that look destructive.

**`reasonId` must be a reason the charity currently offers** — a retired one is a
`422`. A referral already citing a retired reason keeps it.

**Which key is "other information" is still yours.** The server holds no form
definition and does not police which answers moved. That answer is a free note to
whoever runs the session, not a substitute for correcting a field — almost every
fact here has its own field and is corrected outright, above. It earns its place
for what a field can't say: a corrected address reaches the driver, a note
explaining why reaches the person handing the bag over — the answers surface
beside the parcel on the picking screen and on the listener sheet.

### A referral now says what became of the household

`Referral` gains `outcome`: `attended` | `no_show` | `booked`. It answers a
different question from `status`, and the two are not alternatives —

|           | answers                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------- |
| `status`  | what became of the **referral**: awaiting review, accepted, read, rejected, withdrawn             |
| `outcome` | what became of the **household**: they collected, they did not turn up, or they are still to come |

`booked` is "still to come", and covers three ways of getting there: the parcel
is picked and waiting to be marked, no pick list has been made for the session
yet, or the referral was cancelled before the day came.

**So a cancelled referral reads `status: "cancelled"` with `outcome: "booked"`,
and that is not a contradiction.** Nothing happened on the day; the cancellation
is recorded where cancellations are recorded. Do not derive one field from the
other, and do not show them as a single combined state.

Three practical notes:

- **Not admin-only.** A team lead gets it, because they already see who turned
  up on the session screen.
- **Present on every response carrying one referral** — `GET /referrals/{id}`,
  `PATCH /referrals/{id}`, and the accept, reject, review, cancel and copy
  routes. **Absent from the `GET /referrals` list rows**, where deriving it
  means a second query over the whole session. Treat it as optional in your
  generated type and read outcomes off the session screen for lists.
- Same three words and meanings as `RepeatReferralMatch.outcome`, deliberately.

### Copying a referral (admin only)

```
POST /api/v1/referrals/{id}/copy   { sessionId, acknowledgeOverCapacity? }  → 201 Referral
```

A household whose referral came to nothing rings the food bank and is given
another chance. The referral is copied onto a later session and the copy is an
ordinary new referral from there.

**The original is untouched** — same status, same session, same parcel, same
attendance. A no-show stays a no-show on the day it happened. Do not follow this
with a cancel of the original; that would be refused anyway.

**When to offer the button.** Only where the original can no longer come to
anything: `status` is `cancelled` or `rejected`, **or** `outcome` is `no_show`
or `attended`. Anything else is a `409` — a referral still on its way to being
fed is _moved_, not copied, and the two are never alternatives for the same
referral. Gate on `status` and `outcome` together and the screen and the server
agree. A household who has already collected **can** now be copied — a
deliberate second referral, made the quick way rather than through the whole
form again.

**What the copy carries:** the referee's name, date of birth, address, postcode
and phone; `adults`, `children`, `householdSize`, `collectionMethod` (and the
`isDelivery` it derives), `needsFuelHelp`;
`reasonId`; `answers` whole; and the referrer's name, organisation, email and
phone.

**What it does not:** `status`, `sessionId`, `reviewComment`, `adminInfo`, and
any parcel.

**The copy arrives `status: "reviewed"` with `reviewComment: null`.** The
administrator making it has just decided this household should come, so there is
nothing left to accept and nothing waiting to be read. This means copying a
**rejected** referral lets the household in after all — that is the point of the
button. The rejection and its comment stay on the original.

**`adminInfo` on the copy is written by the server**: `Copied from referral
dated YYYY-MM-DD`, the date the **original** was submitted, London. It replaces
rather than extends — the original's note does not come across.

**`referredAt` is the moment the copy was made**, not the original's, so it
sorts as a new referral on the search screen and gets its own fifteen months
before the purge.

**`reasonId` comes across even if the charity has since retired it** — unlike
`PATCH /referrals/{id}`, which refuses a retired reason with a `422`.

**Capacity works exactly like a move.** A full session is warned about, never
refused: send `acknowledgeOverCapacity: true` to confirm, and offer the same
session picker you offer for a move. A cancelled or already-confirmed session
cannot take a copy at all.

**No parcel is created.** The copy holds its place on its new session and is
picked for in the ordinary way when that session's pick list is generated or
opened again.

No Turnstile token — this is authenticated, unlike `POST /public/referrals`.

**Guard the button against a double press if that matters to you.** Copying is
not idempotent and the server does not stop a second copy: two presses make two
referrals on the same session, two places held and two parcels picked. This is
deliberate rather than a gap — the charity does not want it guarded, the same
trade a public referral submission already carries — so the server will not
refuse a second copy for you.

### A forgotten referral can no longer be acted on

Once `piiPurgedAt` is set, `PATCH /referrals/{id}` (correcting **or** moving),
`POST /referrals/{id}/cancel`, `/accept`, `/reject`, `/review` and `/copy` are
all a `409`. Fifteen months on there is no name, no address and no answers left,
so there is nothing to correct, decide on, read through, move or copy. Hide
those controls on a purged referral rather than letting the user find out by
pressing one.

---

## 4. Running a session

```
POST /api/v1/sessions/{sessionId}/pick-list     generate or reconcile
GET  /api/v1/sessions/{sessionId}/pick-list     read the existing list
POST /api/v1/parcels/{id}/review                per household, BEFORE printing
GET  /api/v1/pick-lists/{id}/print              one sheet per parcel
POST /api/v1/pick-lists/{id}/print              mark printed
     …pick, adjusting lines as stock runs out…
POST /api/v1/parcels/{id}/attendance            per household
POST /api/v1/sessions/{sessionId}/confirm       close the session
```

The review step is not optional, and it now comes before printing rather than before attendance: a
pick list is not printable until every one of its parcels has been reviewed, because printing an
unfinished parcel turns an unresolved decision into a bag on a table. Attendance on an unreviewed
parcel is still a `409` too. Reviewing does not freeze anything — lines stay editable afterwards,
right up to the point the session itself is confirmed. **There is no separate pick-list-level lock**
— editing a pick list is refused only once its session is confirmed.

### Generating

Generated on first view. `POST` is idempotent — calling it again reconciles any
household holding a place (`pending_review`, `active` or `reviewed`) which does
not yet have a parcel, and reports how many it added in `parcelsCreated`. It
never alters an existing parcel, so
your line changes and the household snapshot stay intact. Once the session is
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

**The request body is optional.** It carries your preference lines (see **5g**)
and the pick-list information you composed for each household (see **5i**),
either, both or neither.

### Editing

Lines can be changed while `draft` **and after `printed`**. The list locks only
once the session is confirmed. This matters: pickers discover shortages at the
shelf, after the sheet is printed.

`PUT /parcels/{id}/lines` with `quantity: 0` **removes** the line — that is how
"we had none" is recorded.

**The amendment screen shows every stock item, not only the ones in the
parcel**, in category order with a blank against anything the household is not
getting. Adding to a parcel is then typing a number against a line already on
the screen rather than hunting for the item.

**Assembling that is yours, and deliberately so.** `GET /pick-lists/{id}`
returns only the lines that exist; overlay them on `GET /stock/items` (which
now defaults to category order — see **5f**) keyed by `stockItemId`. The server
does not pad the parcel out to every item, for two reasons: it would be ~120
lines per parcel across 25 parcels on a session, and it would destroy the
parcel's own record of what was chosen — a line at zero and a line never added
would become the same thing, and `quantity: 0` already means something else
here.

Before recording either attendance outcome, call `POST /parcels/{id}/review`.
The session list exposes `reviewedAt` on each parcel so it can distinguish a
pending review from a reviewed pick list.

### A household who cancels after the list is generated

Cancelling a referral (`POST /referrals/{id}/cancel`) does **not** delete the
parcel already picked for that household or empty its lines. The parcel is the
record of what the food bank prepared, and it stays exactly as it was. What
changes is that it comes back reading:

```json
{ "attendance": "cancelled" }
```

Treat that as "this snapshot is retained, but the household is not part of this
session any more". Concretely:

- **Leave it off the Run a session client list**, or show it greyed with the
  cancellation plain — not as somebody still to be served.
- **It is not pending attendance.** Do not include it in "everyone ticked off?"
  completion checks, and do not offer the attended / no-show buttons for it —
  `POST /parcels/{id}/attendance` on a cancelled parcel is a `409`. That holds
  even if an administrator cancels while the outcome is being submitted: the
  request is refused and no stock moves, so treat this `409` as "re-read the
  pick list", not as a failed write to retry.
- **It is not pending review.** `reviewedAt` may well still be `null`; that no
  longer holds up printing.
- **It is not printed.** `GET /pick-lists/{id}/print` already leaves it out, so
  there is nothing to filter there.
- **It is not in an SMS conversation.** The session's SMS recipients never
  included it — cancelled households are excluded by status.

The session's `booked` count already excludes it, as do
`GET /sessions/{sessionId}/referral-details` and the listener sheet. Only the
pick list retains the row, deliberately, so a team leader holding a printed
sheet can see why that pick number is not coming.

**A household whose parcel already has an outcome can no longer be cancelled
at all**, and this is now settled rather than assumed. Once they have collected,
been delivered to, or been marked as not having turned up,
`POST /referrals/{id}/cancel` is a `409` and nothing changes. The food has come
off the shelves and cannot be un-given, and cancelling afterwards would leave
the parcel's account of the morning contradicting the referral's. So only a
`pending` parcel ever becomes `cancelled` — not because a recorded outcome wins
a race, but because the cancellation never happens.

**Gate the cancel button on `outcome` as well as `status`.** Two things an
operator might have meant instead:

- the **outcome** was recorded by mistake → take it back through
  `POST /parcels/{id}/attendance`, which undoes the stock with it;
- a household who did not turn up should get **another chance** → copy the
  referral onto a later session with `POST /referrals/{id}/copy`, and leave the
  no-show where it happened.

### Divergence

`GET /pick-lists/{id}/divergence` reports households whose size changed and
referrals since cancelled. While a list is editable, opening it reconciles
newly booked households automatically; once the session is confirmed the list
still reports them as missing because it is locked.

No existing parcel is ever changed automatically. Show household-size changes
and cancelled referrals as warnings and let a human decide what to do.

`cancelledReferrals` is now largely belt-and-braces: those parcels already read
`attendance: "cancelled"` for themselves. It still earns its place for the case
the attendance value cannot express — a parcel already marked `attended` whose
referral was cancelled afterwards keeps the `attended`, and this is the only
thing that says so.

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

### Counting the stock without an account

The people walking the shelves are often volunteers with no sign-in and no
reason to be given one. A team lead (or an admin) generates them a code:

```
POST /api/v1/stock/take/volunteer-codes   →  201 { code, expiresAt }
```

`code` is `XXXX-XXXX-XXXX-XXXX`. It is in that response and nowhere else — only
a hash is stored, so nothing retrieves it again; if it is lost, generate
another and let the old one lapse. Show it to the team lead once, with
`expiresAt` (epoch seconds) alongside so they can see when it stops working.
Generating another code does not invalidate an earlier one — each works until
its own expiry.

The volunteer then sends it on every stock-take request as a header, instead of
a bearer token:

```
X-Volunteer-Code: KP7Q-4XZM-9RTW-2NJH
```

Case and separators are normalised, so what the volunteer types need only be
close. The code reaches exactly four operations — `GET /stock/levels`,
`GET /stock/groupings`, `GET /stock/crates`, `POST /stock/take` — and every
other endpoint answers `401`, the item list and hand corrections included. It
stops working fourteen days after it was issued; there is no way to end one
sooner, and nothing about it survives. A page saved on a code is recorded
against the team lead who issued it.

For the admin screen's "a fresh code is due" warning:

```
GET /api/v1/stock/take/volunteer-codes/latest
  →  200 { latest: { expiresAt, expiringSoon } | null }
```

Admin only. `expiresAt` is the expiry of the unexpired code with the latest
issue time; `expiringSoon` is `true` once it has under five days left.
`latest` is `null` when there is no unexpired code — before the first is
generated, or once the last has lapsed. It never returns the code.

Build the counting screen to accept a code on a device that never signs in.
Everything else about the stock take — the paging, "send only what changed",
no stock-take resource — is exactly as below.

### How stock moves

**Three `movementType` values.** They are a `CHECK` constraint on a table that
cannot be altered without a rebuild, and that column has already been
rebuilt three times by guessing — `correction` is the one exception, a
settled decision rather than another guess, see **5l**.

| Value             | Written by                                                       |
| ----------------- | ---------------------------------------------------------------- |
| `opening_balance` | `POST /stock/take` — one per counted item, at the counted figure |
| `parcel_issued`   | attendance, when a household attends or a delivery lands         |
| `correction`      | `POST /stock/items/{id}/corrections` — a team lead's hand fix    |

There is no shop, no donation and no wastage. The count on the shelf next
week is what the stock is, whatever happened to it in between — a
correction does not change that, it just lets a team lead put one item
right without waiting for the next count.

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

### Can the warehouse cover this session?

```
GET /sessions/{sessionId}/stock-requirement?order=shelf|category
  → { pickListId, items: [{ …StockLevel, requiredQuantity, shortfall }] }
```

**Only the items the session actually needs.** Each line is a stock item one or
more parcels call for, carrying the same fields `GET /stock/levels` returns plus
the two numbers this screen exists for. An item nothing on that morning needs is
absent, not a nought — the list is as long as the work is, and no longer.

- `requiredQuantity` — the total across the session's parcels.
- `quantityOnHand` — the level now, summed from the ledger. **May be negative.**
- `shortfall` — `requiredQuantity - quantityOnHand` floored at zero, so a
  surplus is `0` and anything above zero is the number you cannot find.

**`409` until every parcel has been reviewed** — the same gate as
`GET /pick-lists/{id}/print`, and a cancelled parcel is not waited for. An
unreviewed parcel may still carry a line saying an item needs attention
(`quantity: -1`, see **5g**), which is not a quantity and cannot be added up.
A second `409` guards the `-1` itself, which reviewing already rules out.
**A third `409` once the session itself has been confirmed** — confirming
records every attended household's parcel against stock, so by then that
stock has already left the shelf while the parcel still counts towards this
figure, and the comparison would be a finished session measured against a
shelf nobody can still act on. `404` if the session has no pick list at all.

**Cancelled parcels are excluded; every other parcel counts.** A household that
is not coming is not picked for, the same rule that keeps them off the printed
sheets. A household already marked attended — or marked as a no-show, whose
parcel was still packed — counts towards `requiredQuantity` even though an
attended one's stock has already left `quantityOnHand` —
the figure answers "what does this session ask for", not "what is left to pick".
Read it before the session starts, which is when it is useful, and the
distinction never arises.

Team leads and admins both. Defaults to shelf order.

### What is every session still to come going to need?

```
GET /pick-lists/stock-requirement-summary?upTo=YYYY-MM-DD&order=shelf|category
  → { items: [{ …StockItem, requiredQuantity }] }
```

**Admin only**, and a different figure from the per-session one above: it sums
`requiredQuantity` across **every** pick list whose session is not confirmed and
whose `sessionDate` is on or before `upTo`, not just one session's. `upTo` is
required.

- A `-1` line is skipped rather than causing a `409` — left out of the total,
  never subtracted from it, the same as the fresh-food shopping list treats it.
- Cancelled parcels are left out too.
- **Does not wait for every parcel to be reviewed** — deliberately different
  from the per-session endpoint. It looks across many sessions at once, most
  not yet picked, and a total that only appeared once picking was finished
  would be too late for the planning it is for.
- **No comparison against stock on hand.** There is no `quantityOnHand` and no
  `shortfall` here — just the total required. A referral with no pick list
  generated yet for its session has nothing here to add to the total.
- **The window also has a floor: the start of the current week, Europe/London
  — not a parameter.** `upTo` is the only date you choose. This report is
  about sessions still being planned for, so a session dated before the
  current week does not add to the total however long it has sat unconfirmed.

Defaults to shelf order.

---

## 5. Printing

`GET /pick-lists/{id}/print` is a `409` until every parcel has been reviewed. Once available, it
returns one object per parcel, **lines already ordered by shelf** — a plain string sort of the
shelf label as typed, so `A10` comes before `A2`. Render in the order given.

`POST /pick-lists/{id}/print` is a `409` on the same rule, and it stays one on a **reprint**:
reconciling a late referral adds its parcel unreviewed, so a list already stamped `printed` refuses
both print calls until that newcomer has been reviewed too.

Each line now carries the stock item's `description` (`null` where the item has
none) — print it under the item name. It is where a caveat that does not belong
in the name, like "half a kilo counts as one unit", reaches the person packing
the bag. There is no `category` on a line: the sheet is in shelf order.

What is **on every sheet**: `pickNumber`, `refereeFirstName` /
`refereeSurname`, and the parcel's `notes` — its pick-list information, as
saved. The name used to be withheld on collections; it is now on all of them,
because the person carrying the bag has to hand it to somebody and a number does
not do that.

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
  maintenance screen instead; see below. What a picker needs to be told about a
  household reaches the sheet as the parcel's `notes`, which you compose — see
  **5i**.

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
  → 200 { sessionId, households: [ { referralId, pickNumber, refereeFirstName,
                                     refereeSurname, reason, needsFuelHelp,
                                     answers, firstTimeMarker, voucherInstruction } ] }
  → 409 NEW_CLIENTS_ASSIGNED { error: { details: { missingParcels: [referralId] } } }
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
needs more than these fields, that is a conversation rather than a field to add.

**`firstTimeMarker` and `voucherInstruction` are the same two derived enums
`Parcel` carries** — identical values, derived by the same rules, never
stored on the parcel. The listener is the person actually talking to the
household, so they see whether it is new and what to do about a Christmas
voucher; the client renders whatever wording it likes.

- `firstTimeMarker`: `"first_time"` (review recorded no previous session),
  `"admin"` (review still `unreviewed`), or `null` (a previous-session date
  is recorded). Same as `Parcel.firstTimeMarker`.
- `voucherInstruction`: `null` outside the configured voucher range or with
  no range set; otherwise `"refer_to_admin"` (review still `unreviewed`),
  `"provide_voucher"` (no previous referral, or a previous-session date
  outside the range), or `"already_received"` (previous-session date inside
  the range). Same as `Parcel.voucherInstruction`, and **worked out fresh on
  every read** so a later admin decision shows straight away.

Neither carries the historic previous-session date or anything else about the
referral — that is what makes them safe to hand a team lead.

**Who is on it: the households coming to the session in person.** Settled, no
longer assumed. Awaiting review, accepted and read alike — whether an admin has
read the referral says nothing about whether the household is turning up.

Two groups are **left off, and the sheet is shorter than a session's household
list because of it**:

- **Cancelled and rejected referrals.** They are not coming, and this sheet is a
  list of named people and what went wrong for each of them.
- **Deliveries.** Nobody walks in for one, so a listener will never have that
  conversation. This changed — deliveries used to appear — so a screen that
  reconciles this sheet against the session's households will now find fewer
  rows here, and that is correct.

**Every household on the sheet carries a required `pickNumber`.** The sheet
and the picking sheets are carried round the same hall, and a listener has to
be able to match a household between the two. **This changed too** — producing
the sheet used to be independent of picking, available whether or not a pick
list had been made. It no longer is: a household referred since the pick list
was generated, or before one has ever been generated, has no parcel and so no
number, and `GET /listener-sheet` now refuses the **whole** request with a
`409` and the stable code `NEW_CLIENTS_ASSIGNED` rather than print a sheet
with gaps in it or numbers that do not line up with the picking sheets.
`error.details.missingParcels` names the referrals with no parcel yet — the
same shape `GET /pick-lists/{id}/divergence` already uses for the same idea.
Generate or reconcile the session's pick list first, then ask again.

---

## 5d. Text reminders and replies

The run-session screen gains a **Send SMS Reminders** button and a conversation
per household. Team leader or admin throughout, except the administrator
inbox endpoints below.

```
POST /api/v1/sessions/{sessionId}/sms-reminders   (no body)
  → { reminded, failed, alreadyReminded, simulated }
GET  /api/v1/sessions/{sessionId}/sms-summary
  → { unreadTotal, households: [{ referralId, reminderSentAt, messageCount, unreadCount }] }
GET  /api/v1/referrals/{id}/sms-messages          → the thread, both directions
POST /api/v1/referrals/{id}/sms-messages          { body }  → text them back
POST /api/v1/referrals/{id}/sms-messages/read     → mark that household read

GET  /api/v1/sms-messages/attention-summary       admin only
  → { activeSessionUnread, closedSessionUnread, unmatchedUnread }
GET  /api/v1/sms-messages                         admin only → { messages: [...] }
GET  /api/v1/sms-messages/unmatched               admin only (superseded, see below)
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

**You do not compose the message.** Both greet the household by first name and
say who is texting. Collections get date, time and place; deliveries get date
and the session's delivery window and no address. Both are server-side, and
the wording is fixed — it never carries a surname or an address.

### Simulated sends

Every message — on the thread, in the admin inbox, everywhere `SmsMessage`
appears — carries `simulated`. `true` means this environment's send never
actually reached TheSMSWorks: a dev/test deployment with no provider account,
or a staging one restricted to a single real test number. It still counts as
`reminded`, sets `smsReminderSentAt`, and behaves exactly like a real send in
every other respect — it exists so a `false` next to it is a genuine
assurance, on an environment where that matters (a copy of real referral
data), that a text really went to a real household. Decide for yourself how
much to surface this in the UI; the server does not have an opinion beyond the
flag.

`failure` and `household_reply` always carry `simulated: false` — there is no
simulated form of either.

**The bulk send response carries the same idea as a count.** `simulated` on
the `sms-reminders` response is how many of `reminded` were faked rather than
really sent — a subset of `reminded`, not a fourth bucket alongside
`failed`/`alreadyReminded`. It saves opening every household's thread just to
see whether anything really went out; it is `0` in production, always.

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

**Superseded by the administrator inbox below**, which returns these same rows
(with `location: "unmatched"`) alongside everything else. This endpoint is kept
unchanged rather than removed — build new work against the inbox instead.

### The administrator inbox

Two endpoints, both admin only, neither of which marks anything read:

- `GET /sms-messages/attention-summary` →
  `{ activeSessionUnread, closedSessionUnread, unmatchedUnread }`. No message
  body, household name, phone number or referral data — three counts and
  nothing else, one per `location` below. `closedSessionUnread +
unmatchedUnread` is what to badge an admin nav item with — that is what an
  administrator is actually told needs doing; `activeSessionUnread` is the
  team leader's business, included only so an administrator can see whether
  the team leader is keeping up. Poll it the same way you poll `sms-summary`.
- `GET /sms-messages` → `{ messages: [...] }`. **Not every retained message.**
  Only phone numbers with at least one message that is not a `reminder` — a
  `staff_reply`, a `household_reply` or a `failure`, real or simulated makes
  no difference — appear at all. A number that was only ever reminded, and
  never heard from, is not on this list: there is nothing there for anybody
  to do, and a food bank texting a session's worth of households would
  otherwise bury the numbers that need attention under the ones that do not.
  A number that does qualify is returned **whole** — every message within
  retention for that number, newest first, its reminders included — so
  grouping the response by `phone` gives a complete conversation with no
  second call to expand it.

Each row in the list carries a `location`:

| `location`       | Meaning                                                        | `attention-summary` field         |
| ---------------- | -------------------------------------------------------------- | --------------------------------- |
| `unmatched`      | A loose reply, or any referrer message — no session behind it. | `unmatchedUnread`, if unread.     |
| `active_session` | Its session is still `planned` or `in_progress`.               | `activeSessionUnread`, if unread. |
| `closed_session` | Its session has since been `confirmed` or `cancelled`.         | `closedSessionUnread`, if unread. |

Only unread `household_reply` and `referrer_reply` rows are ever counted at
all — a `reminder`, `staff_reply` or `failure` is never unread, so `location`
is informational for those, not a trigger for any of the three counts.

`session` (session id, `sessionDate`, `startTime`, `status`) is included on
every row except `unmatched`, where it is `null`. `phone` is now on **every**
row, not only `unmatched` ones — group by it client-side to build the
per-number thread this endpoint's filtering is designed to support.

**`phone` can be `null`.** That means the household had no number on file —
`sms-reminders` still records the attempt as a `failure`, since a household
nobody can text is still a household somebody may need to ring. Two different
households with no number are not the same thread: never group two `null`-phone
rows together, and use `referralId` to tell them apart instead.

**`location` reflects the session a message actually arrived about, not
wherever its referral sits now.** Moving a household to a later session
afterwards does not retroactively move an old message with it — a reply that
came in while the household was on a session that has since closed still
reads as `closed_session`, even though the referral itself may since have been
moved onto a session that is still open. There is no separate record of who
picked up an inbox item; a message is still simply read or unread.

`POST /sms-messages/{id}/read` now marks one unread household reply read on a
loose reply or one from a closed session, not only an unmatched one as
before. **It refuses (404) a reply still on an `active_session`** — that one
remains the team leader's to read until the session closes, and this
endpoint does not offer a way around that; open and mark it read through the
referral's own thread instead. It is idempotent and touches only the message
named: it never marks another message and never clears a session's own
`sms-summary` count.

### Referrer collection and SMS

When a referral's `collectionMethod` is `referrer_collect`, **every
parcel-related message about it goes to `referrerPhone`, never
`refereePhone`** — the reminder, and a staff reply sent from that referral's
thread. `kind: 'reminder'` and `kind: 'staff_reply'` rows now carry a new
field, `recipientRole`: `'referrer'` or `'referee'`, telling you which number
a given message actually reached without you having to cross-reference the
referral's current `collectionMethod` (which can itself be corrected later).

**The reminder text for a `referrer_collect` message greets the referrer by
their own first name**, never the household's, and gives the date, time and
place, worded for a referrer collecting a client's parcel rather than their
own — it is never a variant of the ordinary collection/delivery text. It does
not yet distinguish between households when the same referrer is currently
collecting for more than one at once — see `OPEN-QUESTIONS.md` in the server
repo, Q45. A staff reply is unaffected — staff still type their own words,
only the recipient changes.

**Inbound texts from a referrer are a new, distinct kind: `referrer_reply`.**
When an inbound number matches a referrer currently collecting one or more
open `referrer_collect` parcels, the message is categorised this way instead
of `household_reply` — checked first, ahead of the ordinary household
matching, which only runs when the sender is _not_ an active referrer
collector. A `referrer_reply` always has `referralId: null` and no `session`:
a referrer may be collecting for more than one household, so it is never
guessed down to one.

**`referrer_reply` reaches only the two admin-only inbox endpoints above —
never a referral's own thread, and never a team lead.** `GET /sms-messages`
is where you find one: its `candidateParcels` field (present only on this
`kind`) lists every one of that referrer's currently **open**
`referrer_collect` referrals — `{ referralId, sessionId, sessionDate,
startTime }`, nothing else about the household — computed fresh on every
read, not fixed at the moment the message arrived, so a parcel that closes in
the meantime drops off the list on its own. An administrator reads
`candidateParcels` to work out by hand which household a reply was about;
nothing here assigns one automatically, and there is no separate "assign"
call — that judgement stays outside the API.

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

**A move has a second `409` that is not about the session at all, and cancel now
has the same one.** A referral whose parcel already carries an attendance
outcome can be neither moved nor cancelled, even though its session is still
open — a session stays open until _every_ household has an outcome, so one that
has been marked attended or no-show, stock already gone, sits on an open
session. Moving it would say it is due food on a day it has already been dealt
with; cancelling it would leave the parcel's account of the morning
contradicting the referral's. Giving a no-show another chance is a **copy** onto
a later session (`POST /referrals/{id}/copy`), not a move and not a cancel.
Disable both buttons on any referral whose `outcome` is not `booked`, not only
on a confirmed session.

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

`GET /stock/levels` and `/stock/search` behave as they did; `/stock/items` and
item maintenance changed when items gained a category — see **5f**.
**Levels can still be negative** — parcels go out between counts.

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
                          refereeSurname, refereeDateOfBirth, refereeAddress,
                          refereePostcode, refereePhone, needsFuelHelp,
                          answers } ] }
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

`sessionDate` is the session the **parcel was issued at**. Read it as given and
do not join it back to a referral's own session expecting them to match. Moving
a referral now deletes the pending parcel on the session it leaves, and a
referral whose parcel already has an outcome cannot be moved at all, so the two
agree for anything moved from now on — but referrals moved before that rule can
still hold a parcel on a session they no longer point at, and this row is
historical by nature.

**No reason for referral, no household counts, no delivery flag.** None of them
bears on a fuel bill. `refereePhone` is free text exactly as the referrer typed
it — it is **not** normalised, so format for display rather than assuming a
shape, and it may be `null`.

**`refereeDateOfBirth` is new, and this row did not carry it before.** It is
`YYYY-MM-DD` — a date, not an age — and it is there to identify the household to
whoever follows the bill up. It is typed nullable like every personal field here,
but unlike `refereePhone` it is always given on a referral — the only way it
comes back `null` is a purged one, and the retention window is far longer than
this list's fourteen days, so in practice you will not see it.

**`needsFuelHelp` is new too, and on this list it is always `true`** — the
repository already filters on it, so the field is not telling you anything the
row's presence doesn't. It is here anyway, as a plain boolean rather than
something to infer, because it is the same fixed field the client form shows
everywhere else it appears. Unlike the rest of the row it is not personal data
and does not go on the fifteen-month purge.

---

## 5f. Stock items gain a description and a category

`StockItem` has two new fields, and one default changed. **The changed default
is the part that will surprise you**, so it is first.

### `GET /stock/items` now defaults to category order

It used to come back in shelf order. It now comes back **by category, then by
item name within the category** — the order the maintenance screen shows and
the order the pick-list amendment screen offers items in.

Both list endpoints take `?order=category` or `?order=shelf`, and each defaults
to what its own screen wants:

| Endpoint            | Default    | Because                               |
| ------------------- | ---------- | ------------------------------------- |
| `GET /stock/items`  | `category` | maintenance, and amending a pick list |
| `GET /stock/levels` | `shelf`    | the stock take, clipboard in hand     |

An unrecognised `order` is a `400`, not a silent fallback — a pick list quietly
in the wrong order is worse than an error.

### `category`

Free text, required on `POST /stock/items`, `maxLength` 40. There is no
category table and no enumeration to fetch: build a datalist from the
categories present in the item list if you want to help an admin avoid typos.

**The server settles the capitalisation.** Send `tinned goods`, store and read
back `Tinned Goods`. That is what stops one category splitting into two groups
on a screen. Nothing else is corrected — `Tins` and `Tinned` stay two
categories.

`UHT milk` therefore comes back as `Uht Milk`. That is settled and accepted, not
a bug to work around: **display what the server returns**, never what was typed,
or the screen will disagree with the grouping.

An item **cannot exist without a category** and cannot be amended to have none —
it is what two screens are ordered by.

### `description`

Free text, **optional and nullable**, `maxLength` 200. What the item actually
is, where the name does not say it — "half a kilo counts as one unit when rice
is also given". Shown on the maintenance screen and **printed on the pick
list** (see **5**).

On `PATCH /stock/items/{id}`, `null` clears it — and so does `""`. The two mean
the same thing and both read back as `null`, so a cleared field never comes
back as an empty string to special-case.

---

## 5g. Preference lines, and `source` is gone

This is the charity-agreed Q28 design: Option 2's client-evaluated preference
lines, with `-1` representing item-level team-leader attention.

### `ParcelLine.source` has been removed — a breaking change

It held `model` or `manual` and nothing ever read it: no rule branched on it,
nothing reported it, and `INITIAL_SPEC1.txt` never asked for the distinction. It
is gone from the maintenance view and the print payload, which share one line
shape. If your generated types have it, they will stop compiling — that is the
point. Nothing replaces it: after this, nothing in the data explains why a
parcel differs from what the grid says. That is a real loss, accepted because
nobody asked for the answer.

### Sending preference lines

`POST /sessions/{sessionId}/pick-list` now takes an optional body:

```json
{
  "preferenceLines": [{ "referralId": "…", "lines": [{ "stockItemId": "…", "quantity": 2 }] }]
}
```

**You own the rules; the server never reads them.** It holds no form
definition, so it cannot know which answers are preferences or what they mean.
Evaluate your own configuration and send the stock items you resolved — **ids,
never names**. `GET /referrals?sessionId=` gives you everything to evaluate
against (`id`, `adults`, `children` and the whole `answers` map) before any
pick list exists; there is no separate inputs endpoint and none is needed.

What the server does with them:

- Merges them into the parcels **that call creates**, inside the same atomic
  write. There is no second "apply" step and no applied flag.
- **A preference asks for _at least_ its quantity.** Where the model parcel
  already has the item, the higher of the two wins — so a preference can never
  cut a larger household's share, and an item that later joins a model parcel
  cannot silently double.
- **Never touches an existing parcel.** Send the whole session's lines every
  time you generate or reconcile; entries for households already picked come
  back in `preferenceReferralsIgnored` rather than as an error. You do not have
  to track which households you have already covered.
- An unknown `stockItemId` refuses **the whole request** with `422` and
  `details.unknownStockItemIds`, creating nothing. An item that exists but has
  been deactivated since you loaded the catalogue has its line dropped and
  counted in `preferenceLinesDropped` — a retired item must not stop a session
  generating on a Tuesday morning.
- The same referral twice, or the same stock item twice for one referral, is a
  `400`. Two quantities for one item is ambiguous and the server will not pick
  one.
- **A `referralId` that is not on this session refuses the whole request** with
  `422` and `details.offSessionReferralIds`. A stale tab or the wrong session is
  a bug in your view of it, and writing everyone else's parcels around it would
  hide that. A referral that _is_ on the session but is not owed a parcel —
  cancelled, rejected, or already picked — is fine to send and comes back in
  `preferenceReferralsIgnored`.

### `quantity: -1` means _needs attention_

An item your rules could not put a number on — the household asked for it, and
a team leader must decide how much. It is **not a quantity**; never render it
as one, and never add it to a total.

- It **beats any model quantity** in the merge, in both directions. If the
  larger number won, the request would vanish behind a quantity chosen for
  household size that knows nothing about what was asked for, and nobody would
  ever be told.
- **`POST /parcels/{id}/review` is a `409` while one stands.** That single rule
  is what keeps it off a sheet and out of the ledger: printing waits for every
  parcel to be reviewed, and attendance waits for this one. You cannot lose an
  unsettled item by forgetting it — the session cannot proceed past it.
- Settle it with `PUT /parcels/{id}/lines`: the decided quantity, or `0` to drop
  the item. That route takes `0` and above only; `-1` is created at generation
  and cannot be set by hand.

---

## 5h. Session referral details — contact list for the day

```
GET /api/v1/sessions/{sessionId}/referral-details
  → 200 { sessionId, sessionDate, startTime, location,
          referrals: [ { referralId, refereeFirstName, refereeSurname,
                         refereeAddress, refereePostcode, refereePhone,
                         referrerName, referrerOrganisation,
                         referrerPhone, pickNumber } ] }
```

Admin **and team lead**, for the _Run a session_ screen. **You own the print
view**; this is the data behind it.

**This is a contact list, not a listener sheet**, and the two must not be
merged. It carries the household's address, postcode and phone number, the
referrer's name, organisation and phone number, and the household's pick
number, so whoever is running the session can find a door, ring a household
that has not arrived, ring the professional who sent them and know where they
are ringing, or give a picker the household's number over the same call.

**What it does not otherwise carry**, and must not be padded with from other
endpoints: date of birth, the reason for referral, the form answers, the
review comment, the parcel contents, and the referrer's email address. The
reason stays where it was — a team leader gets it on the listener sheet and
nowhere else, and putting it on a second sheet quietly undoes that.

**Deliveries are included here**, unlike the listener sheet. That drops them
because nobody walks in for a delivery; this is the list you ring people from,
and a delivery household is the one the team most needs to reach.

Cancelled and rejected referrals are left off. Ordered by surname then first
name. Every field is nullable **except `referrerOrganisation`**: a purged
household is still on the session and still appears, with nothing left to
contact them by — but who referred them is not what the purge is forgetting, so
the organisation is always a string.

**`pickNumber` is nullable for a different reason than the rest**: it is
`null` when the household has no parcel yet, whether because no pick list has
been generated for the session or because the household was referred after
one was. Unlike the listener sheet, this endpoint is never refused over a
missing pick number — it is a contact list open before picking happens at
all, not a sheet that has to line up against the picking sheets.

---

## 5i. Pick-list information

The free text that goes beside a parcel and onto its printed sheet — allergies,
what the household cannot eat, a preference somebody wrote out in their own
words. It is `Parcel.notes`, which already existed; what is new is that you can
now write it **at generation**, and that it holds 1,200 characters rather than 500.

### Sending it

`POST /sessions/{sessionId}/pick-list` takes it in the same optional body as
the preference lines, and independently of them:

```json
{
  "pickListInformation": [
    {
      "referralId": "…",
      "notes": "Allergies: 2 people who are vegan.\nBeans: Kidney beans please."
    }
  ]
}
```

**You compose the text; the server stores it verbatim.** Which answers belong
on a picking sheet is yours to know for exactly the reason preferences are —
you own the form definition and the server holds none. It never inspects an
answer, never understands a question key, and does the labelling nowhere: send
the finished words, labels and all.

What the server does with them:

- Writes each entry onto the parcel **that call creates** for that referral,
  inside the same atomic write as the parcel and its lines.
- **Never touches an existing parcel's note.** Send the whole session's
  information every time you generate or reconcile — an existing parcel is a
  snapshot the team leader may already have corrected, and the correction wins.
  A note about an allergy is the one thing that must not be quietly reverted by
  a reconciliation.
- A referral on the session that gets no parcel — cancelled, rejected, or
  already picked — is ignored rather than refused, the same ordinary race the
  preference lines tolerate.
- **A `referralId` that is not on this session refuses the whole request** with
  `422` and `details.offSessionReferralIds`, creating nothing — the same rule
  and the same detail key as a preference line.
- The same referral twice is a `400`.
- `notes` is trimmed, must not be empty once trimmed, and is capped at **1,200
  characters**. To clear a note, use the PATCH below with `null`; do not send an
  empty entry here.

### Editing and printing it

`PATCH /parcels/{id}` with `{ "notes": string | null }` is unchanged apart from
the limit, which is now 1,200 to match generation — so a note created at
generation can always be edited and put straight back. `null` clears it.

Editable while the pick list is `draft` **and after `printed`**, on the same
terms as the parcel's lines; `409` once the session is confirmed.

The printed sheet carries `PrintParcel.notes` **as saved**, not the answers as
they read today. Render the parcel's note; do not recompose it from
`Parcel.answers` on the maintenance screen either, or a team leader's edit will
appear to have been thrown away. `PrintParcel` still carries no `answers` and
never the reason for referral — see **5**.

---

## 5j. Christmas voucher and first-time review

Two admin-maintained pieces of state, and two derived, read-only values built
from them — `INITIAL_SPEC1.txt`, `#Christmas voucher and first-time
selection`. Nothing here changes the shape of pick-list generation.

### The voucher date range (admin only)

`GET /voucher-config` / `PUT /voucher-config`:

```json
{ "startDate": "2026-12-01", "endDate": "2026-12-24" }
```

Both dates are `null` until an administrator sets a range. `PUT` always
replaces both together — there is no way to move one end alone. The range is
**inclusive at both ends**: a session dated on either boundary is in range.

Nobody but an administrator reads this directly. A team lead never sees the
raw range, only the two derived values below.

### The first-time review screen (admin only)

Every referral carries `firstTimeReview` — admin-only, absent for a team
lead, the same visibility rule as `reasonId`:

```json
{ "status": "unreviewed", "previousSessionDate": null }
```

`status` is one of `unreviewed`, `no_previous_referral` or
`previous_session`. Every referral starts `unreviewed`; referrals that
existed before this feature shipped were backfilled once to
`no_previous_referral` rather than left as a backlog for an administrator to
work through. `previousSessionDate` is set only when `status` is
`previous_session`.

**The dedicated review screen's candidate list is not a new endpoint.** Reuse
the unchanged `GET /referrals/{id}/repeat-referrals` for the candidate
previous sessions — it already returns every match with its `outcome`. Show
every candidate; a `No Show` or `Not In` match stays visible but you decide
not to make it selectable, and a still-pending match is selectable whatever
it is pending on (its own review, its referrer's, or the session itself).

Save the choice with `POST /referrals/{id}/first-time-review`, exactly one of:

```json
{ "noPreviousReferral": true }
```

```json
{ "previousSessionDate": "2026-01-05" }
```

It responds with the updated `Referral`. It does not check the date you send
against the candidate list — the candidates are for your screen to offer, not
for the server to validate against — and it does not require the referral
being reviewed to be in any particular `status`; only a referral whose
details have been forgotten refuses it, with a `409`. Settled by Pete
(closed Q49): a rejected, cancelled or confirmed-session referral can still
be marked, since the screen is never offered against one in practice.

### Derived value 1: the Run a session marker

`Parcel.firstTimeMarker`, on `GET /sessions/{sessionId}/pick-list` and
`GET /pick-lists/{id}` — safe for a team lead, unlike `firstTimeReview`
itself:

- `"first_time"` — `no_previous_referral`.
- `"admin"` — still `unreviewed`.
- `null` — a previous-session date is recorded. No marker at all, and never
  the date.

### Derived value 2: the voucher instruction

`Parcel.voucherInstruction`, on `GET /sessions/{sessionId}/pick-list` and
`GET /pick-lists/{id}` — for the Run a session screen, alongside the marker
above. **Worked out fresh on every read** — never stored on the parcel,
never generated with the pick list, so a first-time-review decision made
after the pick list already exists is reflected the next time the screen is
opened:

- `null` — no instruction. The session's date is outside the configured
  range, or nothing has been configured.
- `"refer_to_admin"` — in range, `unreviewed`.
- `"provide_voucher"` — in range, and either no previous referral or a
  recorded previous-session date that itself falls outside the range.
- `"already_received"` — in range, and the recorded previous-session date
  falls inside the range too.

Show exactly one instruction where this is non-null; render nothing where it
is `null`. As with the marker above, this is never the historic date and
carries nothing else about the referral. It is **not** on `PrintParcel`: the
voucher is handed over at the session, not off the sheet carried round the
hall, which still has no `answers`, no reason for referral and now no voucher
instruction — see **5**.

---

## 5k. Stock groupings, crates and packing units

Grouped stock-taking: a stock item now belongs to a **stock-take grouping**
above `category`, and several items can be shelved and counted together as
one **crate**. Both are new maintenance concepts alongside the existing stock
item list, and both follow the same role split: `admin` and `team_lead` can
read them (both roles use the grouped stock take), only `admin` writes them.

### `StockItem` gains three fields

`groupingId` (nullable uuid), `unitsPerPack` (nullable positive integer) and
`packUnitLabel` (nullable string) join the existing fields on
`GET /stock/items`, `GET /stock/levels`, `POST /stock/items` and
`PATCH /stock/items/{id}`. (An earlier version of this section also added a
`shelfSortKey` — that has since been removed, see §5m.)

- **`groupingId`** is `null` on a crate member — its grouping comes from its
  crate instead — and otherwise defaults to the seeded `"Non-perishable"`
  grouping on create when omitted. **Nothing keeps this in step with crate
  membership afterwards.** An item that is both directly grouped and a crate
  member, or one that is neither and so would never appear on a grouped stock
  take, is not rejected — it is reported by `GET /stock/validation` below, for
  an administrator to notice and fix.
- **`unitsPerPack`/`packUnitLabel`** are a pair: `packUnitLabel` is always
  `null` when `unitsPerPack` is absent, whatever was sent, and a blank
  `packUnitLabel` sent alongside a real `unitsPerPack` reads as "packs" —
  render it as such rather than as an empty label.

### `GET`/`POST /stock/groupings`, `PATCH /stock/groupings/{id}`

A grouping is just an `id` and a `name` (`maxLength` 40). List is unordered by
role — actually alphabetical, by name. Create and rename are both `admin`
only and `409` on a duplicate name.

### `GET`/`POST /stock/crates`, `PATCH`/`DELETE /stock/crates/{id}`

A crate is a shelf (`shelfKey`, unique across crates) holding several stock
items in fixed proportions. `POST`/`PATCH` **hard-validate**, unlike a stock
item write: at least two `members`, a `groupingId` and every member
`stockItemId` that actually exist, a positive `sizePerCrate`, and both
`stockCompositionPercent` and `shoppingCompositionPercent` totalling exactly
100 across the members — **no all-zero fallback**, so a crate whose shares
have not been worked out yet is refused, not silently accepted.

The two percentage columns serve different moments and are allowed to differ:
`stockCompositionPercent` is how a **counted** crate divides among its
members; `shoppingCompositionPercent` is how a **shopping shortfall** for
that crate should divide among them, which the browser calculates from the
crate definition, stock levels and this column — there is no server
shopping-calculation endpoint.

`PATCH` treats `members` as replace-wholesale, same as a target stock list's
`lines` — omit it to rename or resize a crate without touching who is in it.
`DELETE` is idempotent (`204` on an already-gone id). A target stock list
line that names a deleted crate is not cleaned up — see below.

The crate list stays **ordered by name**. To slot crates into the same order
as `GET /stock/levels` for a combined stock-take screen, compare a crate's
`shelfKey` against an item's `shelfNumber` as plain strings (see §5m).

### `POST /stock/take` gains `crateCounts`

A crate can now be counted as one line instead of counting each member:

```json
{ "crateCounts": [{ "crateId": "…", "enteredCount": 3.5 }] }
```

The server decomposes it into the same per-item deltas a direct `counts`
entry would produce, using `stockCompositionPercent`, and folds them into the
same save — "zero writes nothing" and repeat-safety both still apply,
per-member. `enteredCount` allows **one decimal place**, settled 2026-09-05
(was Q50).

Either `counts` or `crateCounts` may be empty, but not both. **A stock item
named by more than one source in one request is a `400`** — a direct count
colliding with a crate, or two crates sharing a member — the same "ambiguous
instruction" reasoning already applied to a repeated `stockItemId` within
`counts`. `levels` in the response now reports every item actually changed,
direct or crate-derived, not only the ones named in `counts`.

### `GET /stock/validation`

Admin only. A live, non-blocking report — computed fresh on every call, never
stored, and **never used to reject a stock-item write**. Call it after a
successful `POST`/`PATCH /stock/items` and show the result; do not call it
before saving or use it to decide whether to submit.

```json
{
  "issues": [
    { "kind": "crate_member_shelf_mismatch", "crateId": "…", "stockItemId": "…", "message": "…" }
  ]
}
```

`kind` is a stable, closed vocabulary you may key UI off:
`shelf_without_crate`, `crate_too_few_members`, `crate_member_shelf_mismatch`,
`item_uncounted`, `item_grouped_and_crate_member`, `item_in_multiple_crates`.
`message` is for display only — do not parse it.

**Retired items (`isActive: false`) take no part in any check.** A retired item
never makes a shared shelf need a crate, is never `item_uncounted`, and is not
held to a crate's shelf. A crate a retired item still belongs to stays valid —
retiring a member never trips `crate_too_few_members` — and its membership is
left as saved.

### Target stock lists gain a crate line

`TargetStockLine` is now one of two shapes, told apart by `kind`:

```json
{ "kind": "item", "stockItemId": "…", "name": "…", "targetQuantity": 5 }
{ "kind": "crate", "crateId": "…", "crateName": "…", "targetQuantity": 1.5 }
```

Send `kind` on every line from now on. A crate line's `targetQuantity` allows
one decimal place, unlike an item line's whole number — a shopping run can
reasonably ask for half a crate. Same snapshot rules as an item line: stored
and returned exactly as sent, never revalidated against the live crate, so a
deleted crate's line is not removed out from under you.

**A stock item that is currently a crate member cannot be given a new
individual target on a list saved from scratch** — the crate is what gets
bought. Enforced server-side: an item-kind line naming a current crate member
is refused with a `422`, whether on `POST` or on a `PATCH` that sends `lines`.
This does not reach backwards: a `PATCH` that omits `lines` leaves whatever is
stored untouched, so a target already on a list for an item before it became
a crate member, or for a crate since deleted, stays on the list exactly as
saved. Show such a line as needing administrator attention rather than
hiding or auto-removing it.

---

## 5l. Stock corrections

```
POST /api/v1/stock/items/{id}/corrections   { "quantityDelta": -3 }
  → { "quantityOnHand": 17 }
```

A team lead can put one item's level right by hand, between one stock take
and the next, when they discover it is wrong. This is new: `movementType`
gains a third value, `correction` — see **How stock moves** above.

**`quantityDelta` is a signed delta, not a fresh total.** Send the amount the
level is out by — negative to reduce it, positive to increase it — not a
replacement figure. That is the opposite of `POST /stock/take`, which takes a
count and works out the difference itself; a correction is entered the other
way round because the team lead already knows the amount, not the total.
`0` is a `400` — a delta saying nothing changed is refused rather than
written as a no-op row.

**No reason is recorded and there is no history to read back.** Same
decision the charity already made about a stock take's variance: once the
level is put right, nothing is kept about how it came to be wrong or who
made the correction. There is no audit screen for this and none is planned.

**Staff — `admin` and `team_lead`**, the same as `POST /stock/take` it
belongs with. A team lead is who does it in practice, but an administrator
can do everything a team lead can, without exception.

`404` on an unknown stock item, with nothing written. A subsequent stock
take on that item still discards this row along with everything else the
ledger held for it — a correction does not get special treatment from the
"two deletes" rule.

---

## 5m. Shelf ordering is a plain string sort — `shelfSortKey` removed

`StockItem.shelfSortKey` and `Crate.shelfSortKey` are **gone**. They were a
derived natural-sort key (`A2` before `A10`); the charity decided the server
should not be clever about numbers inside a shelf label.

Wherever a list comes back in shelf order — `order=shelf` on
`GET /stock/levels` and `GET /stock/items`, and the line order on
`GET`/`POST /pick-lists/{id}/print` — it is now a **plain string sort of
`shelfNumber` exactly as typed**, so `"A10"` sorts before `"A2"`. Numbering
the shelves so the walk comes out in the right order is a labelling job, not
the server's.

To interleave crates with items on a combined stock-take screen, sort on
`Crate.shelfKey` and `StockItem.shelfNumber` together as plain strings — the
same comparison the server now uses. Nothing needs the old opaque key.

---

## 5n. Dev/test bulk referral import

`POST /api/v1/dev-test/referral-imports` — **not registered in production; it
404s there because the route does not exist, not because it is refused.**
Admin only where it does exist. For your own test-data loader: pick a valid
current reason, attach a session, send prepared anonymised scenarios under one
stable `importKey`, then check the resulting referrals and pick list.

```
POST /api/v1/dev-test/referral-imports
{
  "importKey": "stable-uuid-for-this-run",
  "sessionId": "target-session-uuid",
  "reasonId": "current-dev-or-test-reason-uuid",
  "referrals": [ /* up to 30 prepared scenarios, ReferralSubmission-shaped
                   minus sessionId/reasonId */ ]
}
→
{
  "sessionId": "…",
  "importKey": "…",
  "referrals": [ { "sourceIndex": 1, "referralId": "…" } ]
}
```

What is different from a real submission, all deliberate:

- **Every referral is created `active`.** The referrer-authorisation decision
  a real submission makes — checking `referrerEmail` against the authorised
  list — never runs here.
- **The 16:00-the-day-before booking cutoff does not apply.** A scenario can
  target a session later today.
- **Session-open and capacity still apply**, including delivery capacity,
  checked against the whole batch at once rather than one referral at a time.
- **Every `referrerEmail` must end `example.test`.** Refused otherwise with a
  `400`, regardless of environment — this is defence-in-depth on top of the
  route not existing in production, not instead of it.

**Atomic**: one call creates every referral in it or none of them.
**`importKey` is idempotent**: repeat the same call with the same key and
body and you get the same `referrals` mapping back rather than a second
import; reuse the key with a different body and it is a `409`.

`sourceIndex` in the response is 1-based, following the position of each
scenario in your own `referrals` array — use it to line up which prepared
scenario became which referral id.

---

## 5o. Platform usage monitoring

New screen: the server now records its own Cloudflare Worker and D1 usage
every night, so an administrator can tell whether the food bank is safely
inside the free plan's caps. Admin only, throughout — this is about running
the system, not the food bank's own work.

```
GET /api/v1/platform-stats/usage?from=2026-09-01&to=2026-09-11
→
{
  "days": [
    {
      "date": "2026-09-01",
      "workerRequestsAccountWide": { "value": 41203, "cap": 100000, "threshold": 80000, "exceeded": false },
      "workerRequestsThisApp": { "value": 38940 },
      "workerErrorsThisApp": { "value": 0, "threshold": 0, "exceeded": false },
      "workerCpuTimeP99Us": { "value": 6200, "cap": 10000 },
      "workerSubrequestsAvgPerInvocation": { "value": 9.3, "cap": 50, "threshold": 40, "exceeded": false },
      "workerWallTimeP99Ms": { "value": 310 },
      "d1RowsRead": { "value": 812004, "cap": 5000000, "threshold": 4000000, "exceeded": false },
      "d1RowsWritten": { "value": 22110, "cap": 100000, "threshold": 80000, "exceeded": false },
      "d1StorageBytes": { "value": 41943040, "cap": 524288000, "threshold": 419430400, "exceeded": false }
    }
  ]
}
```

A date with no row in `days` means the job has not captured that day — not
yet configured, not yet run, or a run was missed — rather than a day known to
be clear. Both `from` and `to` are required.

`cap` is one of Cloudflare's own published free-plan limits — a fact.
`threshold` is the level the build currently treats as worth flagging, and
**that number is a guess, not a settled requirement** for the measures that
still carry `x-assumed` on `CappedMeasure` in `openapi.yaml` — see Q44 in
`OPEN-QUESTIONS.md`. `workerRequestsAccountWide` is every Worker on the
account, not just this one, because the 100,000/day cap is shared with the
unrelated `losttemple-api` Worker. `workerSubrequestsAvgPerInvocation` is an
average standing in for a true per-invocation maximum, which Cloudflare's
daily aggregates cannot give — also part of Q44.

Two measures are settled, not guessed: `workerErrorsThisApp` is a raw count,
not a rate, and `exceeded` is `value > 0` — a single Worker error is worrying
on its own. `workerCpuTimeP99Us` carries a `cap` for reference but no
`threshold` or `exceeded` at all (`CapReferenceMeasure`, not `CappedMeasure`)
— the recorded P99 mixes every kind of invocation this Worker handles,
including its own nightly maintenance run, not only the food bank's own
request traffic, so it can never meaningfully mark a day as worrying.

Two measures carry no `cap` or `threshold` at all: `workerRequestsThisApp`
(context for the account-wide figure) and `workerWallTimeP99Ms` (the free
plan sets no duration cap for HTTP-triggered Workers).

```
GET /api/v1/platform-stats/usage/alert-summary
→
{ "windowDays": 14, "daysWithExceededThreshold": 2 }
```

A count for the alert section, not a list — the fourteen days with a
captured row, not literally the last fourteen calendar days if some are
missing.

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
retry — they mean _the session is full_, _this session is confirmed_, _that
reason is no longer offered_. Their messages are written to be shown.

Validation errors name the field and the rule but **never echo the value**, so
you cannot render "you entered X" from the response. Keep your own copy of what
the user typed.

---

## 6a. Extracting to the spreadsheet (admin only)

The charity keeps its records in a Google spreadsheet and this feeds it. **The
server never talks to Google.** It holds no service account, no refresh token
and no access token, and makes no request to any Google API. Your browser
obtains Sheets consent against the administrator's own Google account and does
every write itself; the server hands out configuration, hands out one session
at a time, and records that a session has been written.

```
GET  /api/v1/extracts/config                       → ExtractConfig
GET  /api/v1/extracts                              → ExtractProgress
POST /api/v1/extracts/claims                       → ExtractClaimResponse
POST /api/v1/extracts/claims/{claimId}/complete    → ExtractCompleteResponse
```

All four are admin only.

### The loop

1. The administrator asks to extract. **Confirm first that this might take some
   time** — that confirmation is part of the agreed design, not decoration.
2. Only _after_ they agree, `GET /extracts/config` and ask Google for Sheets
   consent with the `googleClientId` it returns. Do not ask on page load.
3. Read the spreadsheet's **hidden metadata sheet** for the `answerKey → column`
   mapping (see below).
4. `POST /extracts/claims`. `claim: null` means nothing could be handed out —
   that is how a batch ends, not an error. **It does not mean you are done:
   check `remaining` before saying so.** See "A batch ending is not the work
   finishing" below; getting this wrong is the one bug here that loses data
   silently.
5. Write `claim.rows` to the spreadsheet yourself.
6. Only once that write has **actually succeeded**, `POST
/extracts/claims/{claimId}/complete`.
7. After **20 successfully extracted sessions**, stop and ask whether to carry
   on. `remaining` and `extracted` come back on every claim and completion, so
   you have the progress to show without a separate call.

### Claims, and why they expire

A claim reserves one session to one browser, atomically — two administrators
working the queue at once get different sessions, never the same one twice.

**A claim lasts 10 minutes and is not extended by activity.** If the browser
closes, reloads, or the machine sleeps, it lapses and the session returns to the
queue; without that, one abandoned extract would block the queue forever.

**Expiry is the only way a reservation comes back.** There is no route to
release one early, deliberately — so a browser that stops on a failed Google
write leaves that session reserved for the full 10 minutes.

### A batch ending is not the work finishing

`POST /extracts/claims` writes the reservation before it returns the rows. That
is what makes it exclusive, and it is also why a failed write has an
after-effect on the server even though you never called `complete`.

Walk through what an operator sees after a Google write fails:

1. Your write fails. You stop, correctly — you do **not** call `complete`.
2. The session is **not** marked extracted. `extractedAt` stays null,
   `extracted` stays put, `remaining` still counts it. Nothing is lost.
3. But it stays reserved. Press extract again and the server **skips it** and
   hands you the next session down.
4. Once everything unextracted is reserved, you get `claim: null`.

If step 4 is reported as "extract complete", the administrator is told the
spreadsheet is up to date when several sessions are missing from it — and they
have no reason to look again. **`remaining` is what distinguishes the two
states.** `remaining: 0` with a null claim is genuinely finished. `remaining >
0` with a null claim means those sessions are reserved and still to be written;
say so, and that they return to the queue within 10 minutes.

Nothing here is a server bug to wait on: no session is lost and none is written
twice. It is a reporting trap, and the fix is on the screen.

Completion fails in three distinguishable ways, and they are not the same event:

| Response              | Means                                                           |
| --------------------- | --------------------------------------------------------------- |
| `404`                 | No such claim — never issued, or the session has been reclaimed |
| `409` "has expired"   | You were away too long. Your write may well have landed         |
| `409` "belongs to..." | Another administrator's claim; not yours to finish              |
| `422`                 | The deployment has no spreadsheet configured                    |

Show the message. An operator who sees "expired" needs to check the spreadsheet;
one who sees "belongs to another administrator" needs to know a colleague is
working.

### At-least-once, and the one thing you must not automate

The spreadsheet and the database cannot be one transaction. If your Sheets write
succeeds and the completion call then fails, the session stays unextracted and a
later batch sends it again — **duplicate rows are possible, and that is the
intended failure direction.** A duplicate carries `referralId` and can be found
and deleted; a household that quietly never arrived cannot be found at all.

> **Never retry a timed-out Google write automatically.** It may have succeeded.
> Stop, tell the administrator, and let them check the spreadsheet by
> `referralId`.

Retrying the **completion call** is a different thing and is safe: if you never
saw the response, send it again. The second call returns
`alreadyExtracted: true` and changes nothing. It never triggers a Google write.

### The row, and the metadata sheet

`claim.rows` carries **every referral on the session whatever its status** —
cancelled and rejected included, because a referral that was turned away still
happened.

The named fields are the fixed columns: `referralId`, `status`, `referredAt`,
`referrerOrganisation`, `refereeDateOfBirth`, `refereePostcode`, `adults`,
`children`, `isDelivery`, `needsFuelHelp`, `reason` (the label, not the id)
and `reviewComment`. No client or referrer name, address, email address or
telephone number reaches the extract, and **neither does `adminInfo`** — the
purge cannot reach a spreadsheet, and the administrators' note is one of the
things the purge removes.

The claim itself carries the two session columns every row on it shares:
**`sessionDate` and `sessionLocation`**. Write those. **`claim.sessionId` is not
a spreadsheet column** — it is there to complete the claim and to reconcile a
duplicate, and a UUID in a spreadsheet helps nobody, which is the same reason
`reason` is the label rather than the id.

### Stock usage

Alongside `claim.rows`, every claim also carries `claim.stockItemUsage`: one
entry per stock item the session actually issued, giving `stockItemId`,
`stockItemName` and the whole-number `quantity` issued for that item across
every parcel on the session. It is aggregated on the server from the stock
ledger's `parcel_issued` movements for the session — never a per-household
figure, and never anything that would let one movement be told apart from
another: no movement id and no per-movement extracted state reaches this far.

A retired stock item still appears here if it was issued for this session,
the same as a retired referral reason still labels a referral that cited it.
An item the session never issued, or whose issued quantity nets to zero, is
simply absent from the array — including when that leaves it empty: a
session that issued nothing still returns `stockItemUsage: []`, not a
missing field.

`stockItemUsage` is reserved and marked extracted with the rest of the
session, through the same claim and the same `complete` call. There is no
separate queue, no separate reservation, and no way to extract a session's
stock usage without its referral rows or the other way round.

`answers` is an **object, not a JSON string**. The spreadsheet's hidden metadata
sheet owns the `answerKey → column` mapping: read it before your first write,
put each key's answer in that key's column, and write the metadata sheet back
whenever you add a key. **That mapping is spreadsheet state and the server does
not store it** — there is no API for it and there should not be, because the
form is yours and so are the columns.

> **This is the one place personal data leaves the system**, including
> `reviewComment`, which is admin-only in the API because it can name a
> referrer. Everyone the spreadsheet is shared with sees every column, and the
> fifteen-month purge cannot reach it. The charity decided that knowingly.

Nothing is offered before its session is confirmed, so an administrator who
cannot find a session in the spreadsheet should check it has been signed off.

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
