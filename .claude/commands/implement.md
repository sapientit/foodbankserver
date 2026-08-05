---
description: Run a change through the full workflow for this repo — rules, plan, delegation, review, npm run check
argument-hint: <what to build or fix>
---

Implement the following in the food bank API: **$ARGUMENTS**

Work through this sequence. You own it end to end — subagents do slices, not the whole thing.

1. **Ground it in the requirement.** Find it in `INITIAL_SPEC1.txt`. If the spec does not cover it,
   say so and either raise an `OPEN-QUESTIONS.md` entry or ask Pete — do not decide it yourself. If
   Pete settles it in conversation, write it into `INITIAL_SPEC1.txt` **in this same change**.
2. **Investigate.** Use the **Explore** agent for anything broad — where the pattern lives, how a
   similar module does it, what already touches this table. Read the scoped rules in
   `.claude/rules/` that govern the files you will touch.
3. **Plan briefly** and say what you are about to do. Name the modules, the layers and whether
   `openapi.yaml` and a migration are involved.
4. **Build.** Delegate bounded, pattern-following slices to **implementation-worker**, one agent per
   set of files with no overlap. Keep for yourself: the architecture, anything cross-module, the
   contract, and anything the spec does not already settle.
5. **Test.** Delegate to **test-writer**. If this is a bug fix, that comes _first_ and starts from a
   failing test.
6. **Review.** Run **reviewer** on the diff. If migrations, a repository, `db.batch()`, the stock
   ledger, idempotency or PII persistence are involved, run **database-reviewer** in parallel. Read
   both reports critically rather than accepting them; fix what is real.
7. **Integrate and verify.** Read the full diff yourself, then run `npm run check`. It must pass —
   never weaken a rule to make it pass.
8. **Report** the files changed, the checks you ran, what you assumed, and what remains unverified.
   Do not report complete on an unverified assumption.
