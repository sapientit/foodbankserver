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
The plan is that there is no longer a data cleanup operation, just a data delete. Certainly there will be no personal identifiable data held in the json, so a cleanup if it did happen would just anonymise the data the server can see.

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
These questions have been answered by setting up a spreadsheet to maintain the config.

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
All data will be deleted not anonymised.

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
No - the review and the change would be done by the same team lead. No separate "review again" step is necessary

---

## Q30 — Should the four age-band counts become columns in the spreadsheet extract?

`Status: open` · `Raised by: server` · `Blocks: nothing today — the extract still carries the two derived numbers`

The referral now collects four age bands — infants 0-3, children 4-11, teenagers 12-17, adults 18+
— and keeps all four through the twelve-month purge, on the spec's own reasoning that a household's
shape stops being personal once nobody can be named, and that what survives a purge is what the food
bank reports on (`INITIAL_SPEC1.txt`, `#Forgetting a referral`).

**The spreadsheet is where the food bank actually reports.** The extract's fixed columns still carry
only the two derived numbers, `adults` and `children`, so today the four bands are retained in the
database and reach nobody. Either that retention is doing nothing, or the extract is missing four
columns.

The server has not added them, because adding a fixed column to the extract changes what the charity
holds outside its own system — where the purge cannot reach and `requireRole` does not follow — and
`docs/engineering/personal-data.md` is explicit that this is the charity's decision and not a
tidying-up. The dynamic answer columns manage themselves; the fixed ones are contract, and the
client has to be told.

Worth knowing before deciding:

- **An age band is a little more identifying than an adult/child split.** "One infant, one adult" in
  a small village is closer to a household than "two people" is. It is still a long way from a name,
  and the row it sits on has had its name, address, postcode, date of birth and phone number removed
  — but the spreadsheet is the copy that keeps whatever it is given, so it is the copy worth being
  deliberate about.
- **Adding them later is cheap; taking them back is not.** A column added to the sheet in six months
  starts being populated from that day. A column that has been there for six months has six months
  of data in it that nobody can purge.
- **The reporting the charity has actually described** — "we fed 340 households, 890 people" — is
  answerable from the two derived numbers alone. The bands would answer a different question: how
  many of the people fed were babies, or children, or teenagers. That may be exactly what a funder
  asks for, or it may be something nobody has ever needed.

**Question for the charity:** Should `infants`, `children4To11`, `teenagers12To17` and `adults18Plus`
be added to the spreadsheet extract as four more fixed columns, alongside the derived `adults` and
`children` that are already there? If so, should the derived pair stay, or does the sheet want only
the four raw bands?

**A:**
This has been answered separately - the household composition will mean all columns are extracted individually.

---

## Q32 — Does forgetting a referral also clear its parcel's pick-list information?

`Status: open` · `Raised by: server` · `Blocks: nothing today — the note survives the purge`

Pick-list information is now written onto a parcel at generation, out of the answers the client's
form marks as belonging on a picking sheet (`INITIAL_SPEC1.txt`, "Picking list"). The spec describes
what goes in it plainly: "the allergies, what nobody in the house can eat, the preference somebody
wrote out in their own hand."

**The twelve-month purge does not reach it.** `purgeReferralPii` nulls columns on `referrals` only —
the name, date of birth, address, postcode, phone, the answers blob and `adminInfo`. It has never
touched `parcels`, and `parcels.referral_id` has no `ON DELETE` behaviour, so the parcel row outlives
the anonymised referral indefinitely. A year after a household is forgotten, a parcel row can still
read "peanut allergy, EpiPen in the house" against a referral with no name left on it.

This is not new in kind — a team leader could always type the same thing into a parcel note by hand —
but it is newly systematic. Until now generation hard-coded that column to `NULL`; from this change
on, every household's dietary and allergy answers are copied onto every parcel of every session
automatically. So the question the charity was never really asked now has to be answered.

What the charity should know before deciding:

- **The reasoning that nulls `adminInfo` applies here unchanged.** `adminInfo` is purged because it
  is free text describing the household rather than a decision about the referral. A pick-list note
  is exactly that, and its contents are more sensitive than most of what the purge already clears.
- **Clearing it costs nothing operational.** By the time a purge runs, the session is a year gone,
  the food has been handed over and the sheet is long since in a recycling bin. Nothing reads a
  parcel's note after its session is confirmed.
- **But it is not free of consequence either.** The parcel is the record that a household was given
  food and what was in it, and a note is sometimes the only explanation of why a parcel differed
  from its model — a substitution made because of an allergy. Clearing the note leaves the odd
  contents with nothing saying why. That may not matter a year later; it is worth saying out loud
  rather than assuming.
- **A middle answer exists if the charity wants one:** clear the note and keep the parcel's lines,
  on the grounds that what was in the bag is a count and why it was in the bag was a person. That is
  an option, not a recommendation — the server has no basis for choosing between the three.

There is no migration in this either way — `parcels.notes` is already nullable, so purging it is one
more statement in the update `purgeReferralPii` already runs.

**Question for the charity:** When a referral is forgotten at twelve months, should its parcel's
pick-list information be cleared along with the referral's own answers? Or is a parcel a record of a
past occasion rather than of a household, and its note something the food bank means to keep?

**A:**
All data associated with the referral will be deleted at the same time

---

## Q33 — Can a household be cancelled after they have already collected their parcel?

`Status: open` · `Raised by: server` · `Blocks: nothing today — the recorded outcome is kept`

Cancelling a referral now marks its parcel `cancelled`, so a household who pulls out stops reading as
somebody the session is still waiting for (`INITIAL_SPEC1.txt`, "Referral maintenance"). That settles
the ordinary case, where the parcel is picked and the household then rings to say they cannot come.

It does not settle the other one. Nothing stops an administrator cancelling a referral **after** the
team leader has already marked that household as having turned up and taken their food away. The
session stays open to change until it is signed off, so there is a window — a whole session morning
wide — in which both things can have happened.

The server currently keeps the recorded outcome: a parcel marked as attended stays attended, and only
a parcel still awaiting an outcome becomes cancelled. That is a guess, made this way because the
alternative is demonstrably worse rather than because anybody asked for it:

- **The food is gone.** Marking a household as attended is what takes their items off the shelves.
  Rewriting the parcel to say they cancelled would leave the stock movements belonging to a parcel
  that no longer says anyone was fed, and the next stock take would not reconcile.
- **The repeat-referral count would under-report.** That screen counts a household as fed when one of
  their parcels reads attended (`INITIAL_SPEC1.txt`, "Reviewing a referral"). A household who
  collected in March and was cancelled in April would silently stop counting, which is the failure
  that screen exists to prevent.
- **But the administrator did press cancel**, and gets no warning that it did nothing to the parcel.
  If what they meant was "this collection was recorded by mistake", the thing they actually want is
  to take the attendance outcome back — which is a different button, and one they may not know is
  there.

So the question is really about what cancelling means once a household has been fed. The server's own
view is that it is a data-entry mistake in one direction or the other, and that being told so is
better than either silent outcome — but which mistake it is, is the charity's to say.

**Question for the charity:** If a household has already been marked as having collected their
parcel, should an administrator be able to cancel that referral at all? If they should, does the
record say the household was fed, or that they cancelled — and if the answer is that they should be
stopped and told to take the collection back first, say so and it becomes a refusal.

**A:**
No - if they have collected/been delivered to (or even a no show/not-in then they cannot be cancelled. In the no-show event they could possibly be over to a different session, but that would be best done as a clone of the referral - leave the no show where it is. This is a possible future requirement. Currently no cancel after the status has been set.

---

## Q35 — Can a referral whose details have been forgotten still be moved to another session?

`Status: open` · `Raised by: client` · `Blocks: nothing — the client has stopped offering it, which is the guess`

Pete asked on 2026-08-15 for cancel and move to sit together as two buttons on one line of the
referral screen (`screenDetails.md`, the referral detail screen). They did not previously live
together: cancel was inside the block the screen hides once a referral has been purged, and move had
a section of its own that was shown regardless. Putting them on one line settles that difference by
accident, and the client has settled it the strict way — **neither is offered on a purged referral**.

The reasoning for that reading, which is the client's and not the charity's: twelve months on, the
household's name, address and answers are gone, so moving the referral to a future session would put
a parcel with nobody's name on it onto a pick list, and the printed sheet exists to let a volunteer
check they are handing the right bag to the right person.

Against it: nothing was actually wrong with the old behaviour, and an administrator who wanted to
move a purged referral had a reason nobody has asked about.

Mark reviewed is now on that same line and inherits the same rule, so it too has stopped appearing on
a purged referral — where it used to appear at both ends of the page. That one is easier to argue
for: there is nothing left to read through, so nothing to mark as read.

**Question for the charity:** should a purged referral still be movable to another session, and
should it still be markable as reviewed? If either should, that button alone survives the purge while
the rest of the line does not, which is easy enough to write but needs saying, because it reads like
an oversight otherwise.

**A:**
