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

## Q3 — How many times may an attendance mistake be corrected?

`Status: open` · `Raised by: server`

Currently: once in each direction. Attended → no-show → attended is fine; a third change is refused
with a `409` pointing at the stock adjustment path.

The limit exists because every flip moves stock, and unlimited flips produce compensating ledger
entries that cannot be told apart from real movements. But "two" is a number I chose. The
alternatives are unlimited flips (simpler for the team lead, messier ledger) or none at all after
the first (everything goes through an audited adjustment).

**A:**
There is no correction. Once a delivery/collection is confirmed it cannot be undone.

---

## Q5 — How long should someone stay signed in?

`Status: open` · `Raised by: server`

Currently: 15-minute access token, refreshed silently in the background, so in practice a user stays
signed in until they stop using the app. A refresh token presented twice is treated as theft and
signs that user out **everywhere**, including the legitimate holder.

The spec asks for "an expiring security token, with refresh tokens etc." and leaves every number to
us. Two things worth a human view: whether a team lead halfway through recording attendance on a
warehouse tablet with poor signal can tolerate being signed out, and whether the aggressive
replay response is proportionate for this charity.

**A:**
This should not be aggressive. An 8 hour timeout would be acceptable.
---

## Q6 — Who is allowed to log in, and who creates the accounts?

`Status: open` · `Raised by: server`

The spec says how someone proves who they are and never says who is allowed in. The build decided:
invitation-only. Signing in never creates an account; an admin adds you first; there is no
self-service signup and no delete, only deactivation. `migrations/0007_bootstrap-admin.sql` seeds
`pete@x.com`, because otherwise a fresh database has nobody who can create anybody.

That is the safe default for a system holding this data, but it is a whole model nobody asked for.
Also: **is `pete@x.com` the right seed address?** It is currently in a migration, which means it is
in the schema history of every deployment.

**A:**
Pete@x.com will get replaced when we use google authentication.

---

## Q7 — Does the charity want low-stock warnings?

`Status: open` · `Raised by: server`

`lowStockThreshold` per item and an `isLow` flag on stock levels. Entirely invented — the spec has
no notion of running low.

Harmless and probably useful, but it is a column, an input on the item form, and a decision per item
for all 40 of them. If nobody will set the thresholds it is clutter on the maintenance screen.

**A:**
No
---

## Q8 — Are these the right reasons for a hand correction?

`Status: open` · `Raised by: server`

`donation`, `wastage`, `expiry`, `correction`, `opening_balance`. Guesses at how stock leaves other
than through a parcel.

Worth asking because these are the categories any future report on waste or donations will be able
to produce, and they are a `CHECK` constraint — on D1, adding one later means a table rebuild, so
they were enumerated generously on purpose. Missing categories are the expensive kind of wrong here.
Donations in particular: does the charity receive food it does not buy, and does anyone need to
count it separately from a shop?

**A:**
Donations, Shopping, given to clients, wastage, correction and opening balance are the only ones we need.

---

## Q9 — Should confirming a session be blocked, or just warned about?

`Status: open` · `Raised by: server`

Currently refused with a `409` while any household is still unmarked, listing the pick numbers.

The reasoning is that a session closed with people unaccounted for has wrong stock figures. But the
spec has no session-close step at all, and a hard block is unkind if somebody walks out mid-session
and the team lead genuinely cannot say what happened. A warning the team lead can override, with the
unmarked ones defaulting to no-show, is the obvious alternative.

**A:**
Yes - we should have a session close and every client must be either attended (or delivered) or absent (or not in) before the session can be closed.

---

## Q10 — How far ahead should staff see sessions?

`Status: open` · `Raised by: server`

Six weeks, generated nightly. The spec fixes the **public** window at two weeks and says nothing
about the staff view.

Six is arbitrary. It matters a little because a re-timed or cancelled occurrence can only be edited
once it exists, so the horizon is really "how far ahead can the charity rearrange its calendar".

**A:**
Admin can see the full 6 weeks. Team leads can only see 6 days in advance.

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
