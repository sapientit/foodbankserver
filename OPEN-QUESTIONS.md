# Open questions

Things the build had to decide that `INITIAL_SPEC1.txt` does not answer. Each one is a place where
the code is running on a guess — a reasonable guess, but a guess, and the frontend has been built
against it.

**Only Pete answers these.** Neither the server assistant nor the client assistant may close an
entry, including one it raised itself. Two assistants agreeing about what a food bank wants is not
evidence; it is the same guess written down twice. That is exactly how Q0 happened.

## How to use it

**This file holds open questions only.** It is a queue, not an archive. Its length is meant to be
the size of the backlog, so that "how much is still resting on a guess?" is answerable at a glance —
and so that reading the whole thing stays cheap for however many sessions it takes to empty it.

- **Raising one.** Append an entry with the next number. Never renumber, and never reuse a number.
- **Answering one.** Pete writes the answer under **A:**. Only Pete.
- **Closing one.** The assistant that owns the affected repo writes the decision into
  `INITIAL_SPEC1.txt` (see the standing instruction in `CLAUDE.md`), changes the code and the
  contract, removes the matching `x-assumed` from `openapi.yaml`, and then **deletes the entry from
  this file** in the same change.

Deleting is deliberate. Once the answer is in the spec, a copy here is a second place the same
requirement lives, and two homes for one requirement is what this file exists to prevent. Git has
the wording if anyone needs it; the reasoning, if it is worth keeping, belongs in the spec statement
where a reader would look for it anyway.

Q0 stays as the permanent worked example. Everything else leaves when it closes.

`x-assumed` in `openapi.yaml` marks the operations and fields resting on an open entry:

```
grep -n -A3 'x-assumed' openapi.yaml
```

---

## Q0 — Are stocktaking and shopping admin or team leader jobs? — CLOSED

`Status: closed (2026-07-30)`
`Raised by: Pete`

**A:** Team leader. Both are warehouse jobs. Only the stock _item list_ is admin.

Kept as the worked example. Nobody ever decided stock was admin-only — it was inferred while slice 5
was built, written into `openapi.yaml` as flatly as any real requirement, and the frontend generated
its types from it. Five slices later it was still wrong. The cost of the guess was not making it; it
was making it invisibly.

---

## Q2 — How long is personal data kept?

`Status: open` · `Raised by: server` · `Blocks: going live with real data`

Referrals hold names, addresses, phone numbers and a reason for needing food. Nothing currently
deletes any of it. `PII_RETENTION_DAYS` is deliberately unset, so the purge job runs and purges
nothing — guessing a period and deleting somebody's data on the guess would be worse than doing
nothing.

The job, its tests and the cron are all in place. This needs a number, and it is a decision about
what the charity is comfortable defending, not a technical one.

**A:**

---

## Q12 — When personal data is purged, may any of the form answers be kept?

`Status: open` · `Raised by: server` · `Blocks: nothing today — the purge is dormant until Q2`

Closing Q11 moved the referral form into the client, so the server no longer holds a definition
saying which questions ask for personal data. The old purge used that definition to keep the
harmless answers (dietary needs, say) and strip the rest.

It cannot any more, so it now **drops the answers blob whole**. That is the safe reading — an answer
that cannot be classified has to be assumed personal, and keeping one because it looks harmless is
the one mistake a purge cannot take back — but it does throw away anything the charity might have
wanted to report on.

If some answers should survive a purge, the server needs to be told which, and by something more
durable than a client that may have moved on several form versions by then.

**A:**

---

## Q13 — Should a stock take's variance be told apart from a hand correction?

`Status: open` · `Raised by: server` · `Blocks: nothing today — the code works either way`

Closing Q8 fixed the ways stock moves at six: opening balance, shop, donation, parcel given to a
client, wastage, correction. That answer was given to a question about the reasons for **a hand
correction**, and there is one movement it did not obviously have in view: the row a stock take
writes by itself.

A stock take records a count, and the difference between the count and the figure the system holds
becomes a ledger entry. There used to be a seventh type, `stock_take_adjustment`, for exactly that.
With six to choose from, **the code now writes `correction`** — it is the only one it can be. Those
rows still carry the id of the stock take they came from, so a report could still find them, but the
movement type itself no longer separates _we counted the shelf and were two short_ from _a team
leader put a mis-tap right_.

Worth a human view because a stock take variance is the number that says how well the stock figures
are holding up, and because putting a seventh value back costs a rebuild of the whole ledger — the
same reason the original list was enumerated generously in the first place. If the two never need
separating in a report, nothing needs doing and this can be closed as it stands.

**A:**
Suggested answer accepted. Close the question

---

## Q14 — Does the team lead's six-day horizon stop them opening a session further out?

`Status: open` · `Raised by: server` · `Blocks: nothing today — the code works either way`

Closing Q10 gave a team lead a six-day window and an admin the full six weeks. That answer was
about what staff can **see**, and the obvious place it lands is the session **list**. It does not
say whether it is a limit on _looking_ or a limit on _reaching_.

**Where the horizon is enforced today.** `GET /api/v1/sessions` is capped: a team lead gets today
through today plus six, and a `to` beyond that is clamped rather than obeyed. Nothing else is.
`GET /api/v1/sessions/{id}`, `GET`/`POST /api/v1/sessions/{sessionId}/pick-list`,
`GET /api/v1/pick-lists/{id}` and its print, divergence, parcel and confirm routes, and
`POST /api/v1/sessions/{sessionId}/confirm` all serve a team lead any session id they hold.

So a team lead cannot browse to a session eight days out, but if they have its id they can open it
and generate its pick list. Whether that is a hole or the point is a judgement about how the
warehouse works, not about the code. Capping everything is simpler to describe and harder to
explain away; but it would also stop a team lead getting a fortnight's picking ready in advance,
and a session's pick list is the thing they prepare from. Preparing early may be exactly the
practice, or it may be an administrator's job to hand out.

If the horizon should apply everywhere, the enforcement moves down into the session lookup and the
pick-list routes inherit it. If it should not, nothing needs doing and the list stays the only
place it lives.

**A:**
Not worth closing the loophole. Close the question

---

## Q15 — Does a team lead ever need to look at a model parcel or the household grid?

`Status: open` · `Raised by: client` · `Blocks: nothing today — the menu is admin-only meanwhile`

The role table in `API.md` §2 says two things that pull apart once there is a screen to point at.
"Read sessions, stock, referrals, **model parcels**" is ticked for both roles. "**Model parcels and
the household grid**" is admin only. The spec agrees with both readings at once: `GET
/api/v1/model-parcels` and `GET /api/v1/parcel-grid` carry no "Admin only" note, while every
mutation on them does.

That is the same read/maintain split stock has, and the client already renders stock that way —
`/stock` is on a team lead's menu and `/stock/items` is not. So the shape is available if it is
wanted.

**What the client did, and why it is a guess.** Slice 6 built one screen per concern — a model
parcel list with create and delete on it, and a grid editor — and put both on the admin menu only.
There is no read-only view of either, so today a team lead cannot see what a model parcel contains
at all. That is defensible for a maintenance screen and it is still a guess: it was inferred from
the table while building, which is precisely how the stock roles came out wrong in Q0.

The real question is about the warehouse, not the code: **when a picker is holding a pick sheet,
does it ever help to look up what the model parcel for that household size is meant to contain?**
If it does, the fix is a read-only model parcel list on both menus with the maintenance controls
admin-only, and the grid can stay admin-only or come too. If it does not — because the pick sheet
already lists the actual contents, which is the thing being picked — then admin-only is right and
the "read model parcels" row in the table should lose its team lead tick, because it is describing
an ability nobody uses.

Worth answering before pick lists and printing are built, because that is the slice where a picker
would discover they wanted it.

**A:**
No reason to ever look.

---

## Q20 — What are the actual choices on six of the referral form's questions?

`Status: open` · `Raised by: client` · `Blocks: nothing — the form works, but six questions offer a guess`

`Referral questions.csv` gives the questions, the validation and in some cases the default, but for
six of them it does not say what may be chosen. The client has shipped a starting list for each so
the form renders, and every one of them is an invention:

| Question                   | What the CSV gave            | What the client guessed                                          |
| -------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| Toiletries (choose 3)      | the three defaults only      | plus Shampoo, Toothpaste, Toothbrush, Soap, Razors, Shaving Foam |
| Household items (choose 3) | the three defaults only      | plus Bleach, Laundry Powder, Surface Wipes                       |
| Spread (choose up to 2)    | nothing                      | Jam, Marmalade, Honey, Peanut Butter, Chocolate Spread           |
| Nappies                    | "List of sizes"              | Size 1 to Size 6                                                 |
| Baby milk                  | "List of types of baby milk" | First Infant Milk, Follow-On Milk, Hungry Baby Milk              |
| Tea/coffee                 | "Tea/Coffee/Both"            | as given, but see below                                          |

Getting these wrong is recoverable in a way a wrong answer _key_ is not — option lists can change
between releases and `describeAnswers` already renders a stored value the current list no longer
offers. But every week they are wrong is a week of referrals asking for things the food bank does
not stock, or not asking for things it does.

Two of the rows also look internally inconsistent, and a review would be the moment to settle them:

- **Tea/coffee** asks "Would they prefer tea, coffee or hot chocolate?" but offers Tea, Coffee and
  Both. Hot chocolate is in the question and not in the answers, and "Both" of three things does not
  read. The client shipped the answer list as given.
- **Flour/sugar** allows one answer from Sugar, Plain Flour and Self-Raising Flour, so a household
  that needs sugar _and_ flour cannot say so. That may be deliberate rationing, or it may be a
  Google Form limitation that has been carried across.

The list that would settle all of it is the stock item list — these are all things the food bank
either has on a shelf or does not.

**A:**

---

## Q21 — Is there a `reviewed` status, and is review something every referral gets?

`Status: open` · `Raised by: server` · `Blocks: nothing today — the four-status model is built and working`

`referral details.txt` item 7 says, of the administrators' review screen: _"It would make sense to
have an additional status of reviewed (but review is not required, and the session includes it
whether it is reviewed or not."_

That describes a different shape from the one now built. What is built came from the client's
contract change request and is settled: four statuses, `pending_review → active | rejected`, and a
referral only ever waits for review because its referrer's email address was not recognised. A
referral from a known address is `active` immediately and nobody looks at it.

Item 7 reads as though **review is a pass over referrals in general** — something an administrator
may do to any of them, marking it `reviewed`, with the referral counting towards the session either
way. If that is right then `reviewed` is not a fifth value of the same status but a separate flag,
because a referral could be both `active` and reviewed, or `pending_review` and not yet reviewed.
Overloading one column with both ideas is how a status enum stops meaning anything.

Two readings, and the difference is a column:

- **Item 7 is describing the screen, not a new state.** "Reviewed" is just what an administrator has
  done to a `pending_review` referral — accepted or rejected it — and the existing statuses already
  say so. Nothing to build.
- **Review is a separate, optional pass.** Then a `reviewedAt` (or a boolean) is wanted alongside
  `status`, every referral can carry it, and the screen filters on it.

Nothing is blocked meanwhile: the four-status model satisfies everything else in the contract
request, and the review screen can be built on it today.

**A:**

---

## Q22 — What does "approve (authorise referrer)" add to the authorised list?

`Status: open` · `Raised by: server` · `Blocks: the second accept button on the review screen`

`referral details.txt` item 7: _"If it is in a status of 'not approved' (invalid referrer email)
there should be options to approve (once) or approve (authorise referrer)."_

"Approve once" is built — `POST /referrals/{id}/accept`. The second option is not, because what it
should write is not derivable. An administrator looking at a referral from `newstarter@guildford.gov.uk`
could reasonably mean any of:

- **That address, from now on.** An `email` rule for `newstarter@guildford.gov.uk`.
- **Everyone at that domain.** A `domain` rule for `*@guildford.gov.uk` — which is a much bigger
  decision to take from one screen, and the one that would quietly authorise a whole council.

And whichever it is, the new row needs an `organisationName`, which the list is keyed on for
reporting. The only candidate to hand is `referrerOrganisation` as the referrer typed it — free text
they chose, which is exactly the value that ends up as "Guildford BC", "Guildford Borough Council"
and "guildford borough council" as three separate organisations six months later.

So this needs three answers: which match type, what organisation name, and whether the administrator
picks or confirms either on the screen rather than the server deciding. It is a small endpoint once
those are settled.

Worth answering with Q21, since both are about the same screen.

**A:**

---

## Q23 — Which fields may an administrator change on a referral?

`Status: open` · `Raised by: server` · `Blocks: nothing today — the wider set is built, and may be too wide`

`referral details.txt` item 7 ends: _"The session, other information, (and the notes) are the only 3
fields that can be changed."_

What is built is wider, and predates that sentence. `PATCH /api/v1/referrals/{id}` currently accepts
the session (a move), the referee's name, date of birth, address, postcode and phone, the referrer's
name and phone, the household counts, the delivery flag, the fuel-help flag, the reason and the whole
answers map. That came from the spec's "administrators can amend or cancel referrals", which does not
enumerate.

Three things need settling before the surface is narrowed, because narrowing it is not reversible in
practice — a client built against the narrow one will not know it lost anything:

- **Is item 7 describing the review screen only, or the referral generally?** An administrator taking
  a correction over the phone — a referrer rang to say the address is wrong, or the family is now
  four not three — is the case the spec's "amend" sentence was written for, and it needs the wider
  set. A review screen might legitimately offer only three fields while the referral screen offers
  more.
- **What is "other information"?** The referral form has a question keyed `Other` ("Any additional
  information?"). That is a single answer, not the answers map. If it means that one key, then the
  server cannot enforce it — it holds no form definition and does not know `Other` from any other
  key, so "only these answers may be amended" is a rule only the client can apply.
- **What are "the notes"?** There is no notes field on a referral. There is `parcels.notes`, which is
  a picker's note on a parcel and belongs to the pick list, and there is now `reviewComment`, which
  is the administrator's line about the review. Neither is obviously the one meant.

Meanwhile the wider set stands, and a client is free to offer only three fields.

**A:**
