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

---

## Q43 — Which fresh-food items may use stock already on hand?

`Status: open`
`Raised by: Pete`

The fresh-food shopping list aggregates the requirements of pick lists whose sessions are not yet complete. Normally it subtracts the non-negative stock level from that requirement. Some fresh items may instead need to be bought for the coming sessions even when the stock take records stock on hand, because the older stock should not be used. At Christmas the food bank shops more often, so the same stock may be suitable then.

**Question:** How does the food bank decide, for each fresh-food item and for the relevant period, whether to use the stock already on hand or buy fresh? Is this a stock-item setting, a selected shopping-period/list policy (including Christmas), an explicit per-run choice, or something else? What is the required default and who may change it?

**A:**
All stock in hand is used - where food has gone off they will manually change the quantity in stock

---

## Q45 — How does a referrer collecting for more than one household at once tell which parcel a message is about?

`Status: open`
`Raised by: Claude`

Q42 (closed) settled the ordinary wording for a `referrer_collect` reminder: it greets the referrer by their own first name and gives the date, time and place, the same as a household's own collection reminder but addressed to the referrer and naming the client's parcel rather than "your parcel". It does not distinguish between households - a referrer currently collecting for two open `referrer_collect` referrals gets the same wording for each. Pete's answer to Q42 said he suspects this never actually happens, and that he will check with the charity.

**Question:** When one referrer is currently collecting for more than one household at once, does the reminder (and any staff message on that thread) need to say which household's parcel it is about, and if so, how - the client's first name, a session reference, something else?

`x-assumed` in `openapi.yaml` marks the operation resting on this:

```
grep -n -A3 'x-assumed' openapi.yaml
```

**A:**

---

## Q44 — How close to a Cloudflare free-plan cap counts as worrying?

`Status: open`
`Raised by: Claude`

The platform usage report (`INITIAL_SPEC1.txt`, `#Platform usage monitoring`) compares each day's Worker and D1 usage against Cloudflare's published free-plan caps, and marks a line - and counts a day toward the fourteen-day alert - once a measure is close enough to worry about. Cloudflare's caps themselves are facts, not guesses: 100,000 Worker requests per day (account-wide, shared with the unrelated `losttemple-api` Worker on the same account), 50 subrequests per Worker invocation, 5,000,000 D1 rows read per day, 100,000 D1 rows written per day, and 500MB per D1 database. How much margin before that counts as worrying is not.

Two measures are settled and no longer part of this question: processing time is now reference-only against Cloudflare's 10ms-per-invocation CPU cap and never marks a day or feeds the alert, because the figure mixes every kind of invocation - including the nightly maintenance run - not just the food bank's own request traffic, so closeness to that particular cap doesn't mean what it would for a pure request-handling measure (2026-09-13). And the Worker error count is worrying the moment it is non-zero at all - not a rate, and not a margin (2026-09-13).

One measure still has no Cloudflare cap to take a margin of at all: subrequests, where Cloudflare's analytics only give a daily total rather than a true per-invocation maximum, so the build uses the average subrequests per invocation as a stand-in for the 50-per-invocation cap rather than the cap itself.

Until Pete decides, the build assumes a flat 80% of each remaining Cloudflare cap counts as worrying, and 80% of the 50-subrequest cap (i.e. an average of 40) for the subrequests stand-in.

**Question:** What margin should count as worrying against each remaining Cloudflare cap (Worker requests account-wide, D1 rows read, D1 rows written, D1 storage) - one flat percentage for all of them, or a different one per measure? And what average-subrequests figure should count as worrying, given it's a stand-in rather than the cap itself?

`x-assumed` in `openapi.yaml` marks the fields resting on this:

```
grep -n -A3 'x-assumed' openapi.yaml
```

**A:**
The current settings are a good starting point. Close this question
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
