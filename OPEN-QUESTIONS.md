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

## Q12 — When personal data is purged, may any of the form answers be kept?

`Status: open` · `Raised by: server` · `Blocks: the purge, once PII_RETENTION_DAYS is set to 365`

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

## Q27 — When a referral is forgotten, is it anonymised or deleted?

`Status: open` · `Raised by: Pete` · `Blocks: nothing today — the purge is written the anonymising way`

Twelve months is settled (`INITIAL_SPEC1.txt`, `#Forgetting a referral`). What is not settled is what
"stops holding the household's details" does to the row.

**What it does today — anonymise.** `purgeReferralPii` nulls the referee's name, date of birth,
address, postcode, phone and every form answer, and stamps `piiPurgedAt`. The row stays. What
survives is `adults`, `children`, `isDelivery`, `needsFuelHelp` and `reasonId` — deliberately,
because the spec says those become counts rather than people once nobody is identifiable, and they
are what the food bank reports on. The referrer's own details and the administrator's
`reviewComment` survive too, because the point of forgetting is to stop holding details of the
household, not to lose track of the professional who sent them.

**Pete's view on 2026-08-06** was that since the charity is now committing to hold personal data for
a full twelve months, deleting outright at the end of it might make more sense than half-keeping the
record. That is a reasonable instinct and it is why this is being asked rather than left.

What the charity should know before deciding:

- **Deleting ends reporting beyond twelve months.** "We fed 340 households, 890 people, 22% for
  benefit delay" is answerable today for any period, because the anonymised rows are still countable.
  Delete them and the food bank can report on the last twelve months only — no year-on-year
  comparison, which is usually what a funder or a trustee asks for. This is the single biggest cost
  and it is not recoverable later.
- **It also deletes the referrer's record.** `referrerOrganisation`, `referrerName`, and the
  `reviewComment` explaining why a referral was accepted or rejected all live on the same row. The
  spec currently says those are kept on purpose. Deleting the row reverses that decision as a side
  effect, so if deletion is chosen the spec needs to say whether that is intended.
- **It is not currently possible without also deciding about the parcel.** `parcels.referral_id`
  references `referrals.id` with no `ON DELETE` behaviour, so SQLite refuses to delete a referral
  while its parcel exists. Deletion would need either a table rebuild to add `ON DELETE SET NULL`,
  or to delete the parcel too — and the parcel is what records that a household was given food and
  what was in it. So "just delete it" is really "and what happens to the record that a parcel was
  issued?", which is a second question the charity has to answer.
- **The argument for deleting is that anonymised is a claim, not a fact.** A row the charity
  describes as anonymous is one it must keep confident really is. Today it plainly is — the retained
  fields are five numbers and a dropdown. But "we no longer hold it" is simpler to say to a
  household who asks, and simpler to defend, than "we hold a record of you with the identifying parts
  removed."
- **There is a precedent pointing both ways.** Text messages are **deleted** after thirty days, and
  `purge-sms.ts` explains why: the message body _is_ the personal data, so an empty row records
  nothing worth reporting on. Referrals were made to null rather than delete for the opposite reason.
  Whether that reasoning still holds is exactly what this question asks.

A middle answer exists if the charity wants one: keep a counts-only row with no link back to the
referral at all, and delete the referral. That preserves reporting and holds nothing about a person,
at the cost of a second table and the work to maintain it.

**A:**

---

## Q28 — Should selected preference answers automatically add matching stock items during pick-list review?

`Status: open` · `Raised by: client` · `Blocks: nothing today — the server is built on an assumed answer and can be unbuilt`

> **Built on an assumption, 2026-08-11.** Pete asked for the server side to be built ahead of the
> charity's answer, assuming **Option 2 with item-level attention**: the client evaluates its own
> preference rules and sends resolved stock items with `POST /sessions/:id/pick-list`, and an item
> needing a decision travels as a parcel line with `quantity: -1`. That is now shipped behind
> `x-assumed` markers in `openapi.yaml`, and `INITIAL_SPEC1.txt` deliberately says nothing about it
> — it is a guess, and it must not read as a requirement until the charity answers.
>
> **The question below is unchanged and still open.** If the charity chooses Option 1, the request
> body and the merge come out. If it chooses answer-level attention, `-1` comes out, the quantity
> CHECK on `parcel_lines` narrows back to `> 0` in a further rebuild, and the attention data needs
> a representation this design does not have.
>
> One thing the build surfaced that the question does not cover: **a preference asks for _at least_
> its quantity** — where the model parcel already contains the item, the higher of the two wins. It
> cannot express "the model parcel _plus_ one more", and switching to addition later would silently
> change what every household receives. Worth asking the charity in the same breath.

The referral form has preference questions whose answers tell a team leader what a household asks
for. Today the model parcel is the starting point and a team leader reads those answers, finds the
stock item and adds it manually. For a session of 25 households this repeats the same work many
times, especially for multi-select questions such as toiletries and household goods.

Two client-owned options are proposed. **Option 1** is deliberately small: a choice preference may
say `autoPicking: true` in the existing referral-form configuration. Each selected answer must
exactly match the name of one active stock item; on first review the client adds each matching item
at quantity 1 to the editable draft and labels it as applied from preferences.

**Option 2** is for repeatable rules that need a small amount of household context. A rule still
starts with one preference key, but has an ordered `cases` array and a compulsory `otherwise`
result. Cases are read in written order and the first match wins. `otherwise` supplies the result
when no case matches; it is present even when `cases` is empty, so there is no second shorthand
syntax to remember. For a multi-select question, `$selectedAnswer` stands for each chosen answer
and can be used as the exact stock-item name. Thus one rule can say that every selected toiletry is
quantity 2 for four or more people and quantity 1 otherwise, without repeating every toiletry.

Option 2 is deliberately bounded, not a general programming language. Each case has only one
possible secondary condition: `familySize`, with `people` set to `adults`, `children` or `total`,
and a whole-number `atLeast` threshold. `total` means adults plus children. Cases remain ordered
and first-match-wins, with fixed quantities. This permits, for example, two of every selected
toiletry for four or more people and one otherwise, without a generic comparison language. It does
not permit nesting, arbitrary expressions, substitutions, family facts that the referral has not
collected, or rules referring to other rules.

Under either option, preferences without a rule, free-text preferences, and anything whose
configured name does not match exactly one active stock item would stay clearly visible as **Needs
attention** for the team leader. An admin-only rule-health check would validate the shipped
configuration against live stock items in each environment, and reject unknown keys, invalid
`familySize.people` values, non-integer `atLeast` values, unavailable choice values, a missing
`otherwise`, and conflicting writes to one stock item. A missing or duplicate stock name would be
an obvious configuration error, never a silent substitution.

The server would continue to generate only model parcels and would never read the client JSON.
The client would evaluate the rules against the referral facts and the stock-item list it already
has, resolve exact names to stock-item IDs, and send those resulting lines with pick-list
generation. The server still chooses the referral and model parcel, then merges the supplied lines
atomically only while creating a new parcel. Existing parcels are never changed on reconciliation,
so there is no second apply step or `autoPreferencesAppliedAt` flag.

The existing model parcel remains responsible for household size generally. Option 2 only adds
limited, explicit preference rules where the charity says they are needed. A preference that needs
facts the referral does not collect — for example a quantity based on girls above a particular age
— remains **Needs attention**, rather than inventing a value.

One interface detail is deliberately still **TBD**: whether **Needs attention** belongs to the
preference answer or to a particular stock item. Answer-level attention would show “Sanitary
products: Yes”, leaving the team leader to choose both item and quantity. Item-level attention
would say, for example, “Tampons requested — decide quantity”, which is more direct but encodes a
stock choice where the referral may not provide enough information. No `needsAttention` rule shape
should be settled until this is answered.

If item-level attention is chosen, the proposed representation is a parcel line with quantity
`-1`: it means the named item needs a team-leader decision, not that the household receives a
negative quantity. The editor would render it as **Needs attention**, and the team leader would
replace it with a positive quantity or remove it with zero. A parcel containing `-1` could not be
reviewed, printed or issued. This avoids a separate task list and does not need a `source` field.

**Question for the charity:** Is Option 1 sufficient, or are there recurring preference rules where
Option 2's limited household-context cases would remove real repeated work? Please give concrete
examples, including the desired quantities for different household sizes. In either case, is the
proposed workflow right: place the automatic items into the team leader's editable draft on first
review, while leaving every other preference explicitly needing attention? When attention is
needed, should it identify the original preference answer, or name a particular stock item whose
quantity/suitability the team leader must decide? If the latter, does the `-1` unresolved-line
approach match how the team wants to work?

**A:**

---

## Q29 — Does changing a parcel's contents after it was reviewed take the review back?

`Status: open` · `Raised by: server` · `Blocks: nothing today — a review survives any later edit`

Printing now waits for review (`INITIAL_SPEC1.txt`, first section), which gives an existing
behaviour a consequence it did not have before. A parcel's lines and notes stay editable after it
has been reviewed, and editing them leaves `reviewedAt` where it is. So a team leader can review a
parcel, change what is in it, and print — with the sheet showing contents nobody signed off.

Nothing was changed to make this so; it is what the code has always done, and the same is true of
the review that attendance waits for. The question is whether the charity means a review to be a
decision about _this parcel as it now stands_, in which case an edit should take the review back
and the parcel should need reviewing again before the list can be printed, or a decision about
_this household_, in which case a later tweak — a picker swapping one tin for another as stock runs
out — should not send the whole list back round the team leader.

The second reading is what the system does today. It also matches the spec's insistence that
changes can still be made after printing, which would be hard to work with if every change undid a
review. But that is an argument, not an answer, and the two readings differ on the sheet in a
volunteer's hand.

**Question for the charity:** After a parcel has been reviewed, does changing its contents mean it
needs reviewing again before the list is printed? If so, does the same apply to changes made after
printing, before attendance is recorded?

**A:**
