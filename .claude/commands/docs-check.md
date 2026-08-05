---
description: Check this repo's spec, contract and status documents for drift against each other and the code
argument-hint: [optional area to focus on]
---

Check the documentation and contract for drift. Focus: **$ARGUMENTS** (default: everything).

These files carry requirements and are the only channel to the client repo, so drift here is not
cosmetic. Investigate with **Explore** where a sweep is needed, then verify each candidate yourself.

1. **`openapi.yaml` against the code.** Run `npm run check:openapi` first. Then look for what it
   cannot catch: a field name or type that no longer matches the handler, a response mapper that has
   widened, a role's visibility described in `API.md` that the mapper does not enforce.
2. **`x-assumed`.** `grep x-assumed openapi.yaml` — for each, is it still an assumption? Does it
   have a live `OPEN-QUESTIONS.md` entry? An `x-assumed` on something Pete has since settled should
   be removed and the spec updated; a settled entry still open in `OPEN-QUESTIONS.md` is drift.
3. **`OPEN-QUESTIONS.md`.** Every entry still genuinely open and still relevant. **Never answer
   one** — only Pete closes one, and closing means writing the answer into `INITIAL_SPEC1.txt` and
   deleting the entry. Report questions that the code now appears to have answered by itself; that
   is a requirement decided without anyone deciding it.
4. **`INITIAL_SPEC1.txt` against behaviour.** Anything the code does that the spec does not say, and
   anything the spec says that the code does not do. Report both; change neither without Pete.
   Ignore `INITIAL_SPEC.md` except as background — never resolve a disagreement in its favour.
5. **`STATUS.md`** — does it match what is actually built and configured?
6. **`docs/` and `.claude/rules/`** — any rule contradicted by the current code, any doc link that
   404s, any rule file whose `paths:` no longer match a real file.

Report findings grouped by document, each with the evidence. Propose corrections for `STATUS.md`,
`docs/` and stale `x-assumed` markers. **Do not edit `INITIAL_SPEC1.txt` or `OPEN-QUESTIONS.md`** —
list what needs Pete's decision instead.
