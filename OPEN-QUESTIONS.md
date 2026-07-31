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
