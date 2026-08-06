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
No reason for the team leader to ever look.

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

## Q24 — Does the Google Sheets export carry names and addresses?

`Status: open` · `Raised by: server` · `Blocks: the export's row shape — see [docs/planned/google-sheets-export.md](./docs/planned/google-sheets-export.md)`

The charity wants every referral to end up in a Google Sheet, fed automatically by a cron job. What
is unsettled is **which columns**: the referee's name, date of birth, address, postcode, phone and
reason for referral, or only the non-identifying parts — session, date, household counts, delivery
flag, attendance outcome.

Pete's view on 2026-08-05 was that he saw no reason to copy names and addresses, and also that the
charity already keeps this data in Google Sheets today. Both are true and neither settles it, so it
is being asked rather than assumed.

What the charity should know before deciding:

- **The database is pinned to the EU jurisdiction and cannot be moved.** That pinning is why
  [`docs/engineering/personal-data.md`](./docs/engineering/personal-data.md) currently states that
  nothing carrying a referee's name, address, phone number or reason for referral may leave D1 —
  including to a third-party fetch, which is exactly what this export is. Sending personal fields
  means changing that rule deliberately, in the spec, not quietly in a job. A Google Workspace with
  EU data regions configured keeps residency; a personal Gmail account does not.
- **The purge cannot reach the Sheet.** Whatever `PII_RETENTION_DAYS` is eventually set to (**Q2**),
  it clears rows in D1 only. Personal data in the Sheet stays until somebody deletes it by hand, so
  the answer to Q2 becomes partly untrue the day this ships with personal columns in it.
- **Who can see the Sheet is outside this system entirely.** Roles, `requireRole` and the response
  mappers stop at the API boundary. Anyone the Sheet is shared with sees every column in it.

None of this makes the answer no. The charity may have a good reason and already has this data in
Sheets. It makes it a decision worth taking on purpose.

**A:**
Tbc

---

## Q26 — Who appears on the listener sheet?

`Status: open` · `Raised by: server` · `Blocks: nothing — built on an assumption, marked x-assumed`

The listener sheet lists the households on a session. Which households was never settled, and the
build had to choose.

**What it does today:** the sheet lists referrals that are `active` or `pending_review` — the same
set that holds a place on the session, i.e. everybody who might walk through the door. Cancelled and
rejected households are left off.

The reasoning, which is a guess and not a requirement: they are not coming, and a listener sheet is
a list of named people against what went wrong for them. Handing a volunteer the name and the crisis
of somebody the food bank turned away, or who cancelled, is the harm this endpoint most obviously
risks.

But it is arguable the other way. A household that cancelled may still appear on the day, and a
listener who cannot find them on the sheet has nothing to work from. And a rejected referral is
still a household that asked.

Worth a human answer because the cost of being wrong points in two different directions: too narrow
and a listener is unprepared, too wide and somebody's crisis is on a sheet in a hall when they were
never coming.

**A:**
Cancelled and rejected and deliveries not included.
