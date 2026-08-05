---
description: Independent multi-agent review of the current uncommitted diff (or a named scope)
argument-hint: [optional scope, e.g. a path or "the attendance change"]
---

Review the current change independently. Scope: **$ARGUMENTS** (default: everything in
`git status` / `git diff` that is not already committed).

1. Establish the diff first — `git status --short` and `git diff` — and summarise what changed
   before dispatching anything. If the working tree mixes unrelated work, say so and review only the
   part in scope.
2. Dispatch **in parallel**:
   - **reviewer** — correctness, requirements, edge cases, PII, role visibility, error handling,
     races, tests, scope creep, rule divergence, stale `openapi.yaml`.
   - **database-reviewer** — only if migrations, the Drizzle schema, a `*.repository.ts`,
     `db.batch()`, bulk inserts, the stock ledger, uniqueness, idempotency or PII columns are
     touched.

   Give each the exact file list and what the change was meant to do.

3. **Do not accept either report at face value.** Verify each material finding against the code
   yourself. Drop what does not hold up and say that you dropped it.
4. Present the surviving findings **Critical → High → Medium → Low**, deduplicated where the two
   agents found the same thing, each with file, what is wrong, why it matters, and the smallest fix.
5. State plainly what was **not** verified, and whether `npm run check` has been run on this diff.

Report only. Do not fix anything unless asked.
