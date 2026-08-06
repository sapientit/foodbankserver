# Planned: the Google Sheets export

**Agreed with Pete on 2026-08-05. Not built**, and `INITIAL_SPEC1.txt` does not describe it yet.
When this is built, the spec changes in the same commit and this file goes away.

## What the charity wants

Every referral is to end up in a Google Sheet. They already keep this data in Google Sheets, and
they want the food bank system to feed it rather than replace it.

**They will not copy, paste or import anything.** That is the requirement that decides the design: a
CSV download was offered and rejected on exactly that ground.

It does not have to be quick. Not synchronous, not guaranteed overnight — periodic is fine, and
"eventually" is the word Pete used. A run that only gets halfway is progress, not a failure.

### What goes across

**A completed session, and every referral on it — the cancelled ones included.** Nothing goes across
before its session is finished.

A confirmed session is terminal, and confirming it fixes its attendance outcomes too — an outcome
can be taken back only while the session is open. So **the Sheet is only ever appended to** — no rewriting a row because a
referral changed later, no mirror-versus-log question, no dedupe beyond the marker. This falls out of
the scope Pete chose; it is not an assumption to be relaxed casually, because relaxing it brings all
of that back.

### Where it runs

**A cron in this Worker**, alongside the existing `17 2 * * *` purge. Not a local script and not a
browser button: both were considered and both need a person, and one of them needs a service-account
key on somebody's laptop. The charity's requirement is that nobody does anything.

Schedule not yet chosen. Anything from hourly to daily satisfies "eventually".

## Credentials

A Google **service account**, with the Sheet shared to its email address once, by hand.

- `wrangler secret put GOOGLE_SA_CLIENT_EMAIL --env production` and `GOOGLE_SA_PRIVATE_KEY`. Two
  secrets rather than the whole key JSON — smaller blast radius, easier to rotate.
- Cloudflare secrets are **write-only once set**: not readable from the dashboard or the CLI, not in
  `wrangler.jsonc`, not in git. Locally they go in `.dev.vars`, which is gitignored.
- **CI must not need them.** `npm run check` runs with no Cloudflare account today and must keep
  doing so; if a test needs a value, bind a fake in `vitest.config.ts`.
- **Inert without them**, following the purge rather than `AUTH_JWT_SECRET`: a dev environment
  should not need Google credentials to boot. Add the row to `STATUS.md`'s "awaiting configuration"
  table when it lands.
- Never log either secret, and never let one reach an error message. `core/log.ts` will not carry
  them, but a raw `fetch` failure from Google might quote a request — treat it like a database error
  and go through `toSafeError`.

No dependency is needed. The service-account JWT is RS256 via WebCrypto (`importKey` on the PKCS8
key, then `sign`), exchanged at `oauth2.googleapis.com/token` for a one-hour access token, then
plain `fetch` against the Sheets REST API. The `googleapis` Node library does not run in workerd and
is not wanted.

## How a run works

**There is no cursor.** The session carries the marker, and the job takes whatever sessions are
still unmarked:

1. Select up to N finished sessions with `exported_at IS NULL`.
2. Read their referrals — cancelled ones included.
3. Append a row per referral to the Sheet.
4. Stamp `exported_at` on exactly those session ids.
5. Stop. The next tick takes the next N.

### The marker goes on the session, not the referral

Decided 2026-08-05. **A row in the Sheet is a referral, but the unit of export is the session.**

Every referral belongs to a session, cancelled or not, and the session is the thing that reaches a
terminal state. So the session is what gets flagged, and its referrals — including the ones cancelled
off it — travel with it when it goes. A referral is never independently exportable, which is what
makes one marker column enough.

It also makes a session's export atomic in the only sense that matters here: a session is in the
Sheet complete or not at all, rather than half its households arriving on one run and half on the
next.

### Why not a timestamp cursor

The first sketch paged on `from`/`to` timestamps with an `isMore` flag, then on a `(timestamp, id)`
keyset cursor over `sessions.confirmed_at` and `referrals.cancelled_at`. **Both are wrong, and the
reason is worth keeping so neither comes back.**

- **Stamp order is not commit order.** Two confirmations in flight can be stamped 10:00:00.000 and
  10:00:00.100 and commit in the opposite order. If the job runs in between and stores a mark of
  `.100`, the `.000` row lands permanently behind the mark and is **never exported** — a completed
  session silently missing from the Sheet. It takes two confirmations in the same window plus the
  cron firing inside it, so it is rare; rare silent loss of a referral is exactly the failure this
  repo exists to avoid. `.claude/rules/time.md` also notes that `Date.now()` does not advance during
  a request until I/O occurs, so identical timestamps are commoner than they look.
- **Workers clocks are not fleet-monotonic.** Two confirmations handled in different data centres
  can be stamped out of order regardless of what happened first. There is no clock to appeal to.
- **Underneath both: the export is driven by state transitions, not row creation.** Confirming a
  session is an `UPDATE`. There is no insertion order, no rowid, no sequence recording that one row
  became exportable after another. No choice of sort column fixes that.

A marker needs no ordering guarantee at all. A row that commits late is not behind anything — it is
still `NULL`, so the next run takes it. Self-healing by construction rather than by getting the
ordering right.

It is also better operationally: **"what has not reached the Sheet yet" is a query rather than an
inference.** Give it a partial index on `WHERE exported_at IS NULL` and the scan stays proportional
to the backlog rather than to the table.

`system_jobs` therefore needs **no cursor column** — it keeps doing what it does now, which is
making a cron that has silently stopped firing visible.

### The seam that cannot be made atomic

D1 and Google are not in one transaction. If the Sheets write succeeds and the stamping then fails,
the next run appends those rows again.

**This is at-least-once delivery and it should be designed for, not wished away.** Write to Sheets
first and stamp second, so the failure mode is a duplicate rather than a silent loss — losing a
referral is much worse than exporting one twice. Carry the referral's id as a column so a duplicate
can be spotted and removed, and so anyone reconciling the Sheet against the system has a key to do
it on. A failed Sheets call must **not** stamp anything.

## Carry these into the build

1. **The export needs its own allowlist.** Response mappers are the output allowlist for the API for
   a reason, and an export is an output. A `toExportRow()` per resource keeps "somebody added a
   column to `referrals`" from silently widening what leaves the building. This matters more here
   than on any API route, because what leaves goes to a third party.
2. **It is a job, not a route.** `modules/jobs`, reading through services, never reaching into
   another module's repository — same as `materialise-sessions.ts`.
3. **Log counts, never rows.** `LogContext` permits identifiers and counts by construction, so this
   is enforced rather than remembered — but it means the job reports "42 rows exported", and that is
   all it can ever report.
4. **The 10ms CPU limit is the free plan and does not apply.** Paid Workers get 30s of CPU per
   invocation and up to 15 minutes for cron-triggered handlers, and **CPU time excludes waiting on
   D1 or on Google**, which is nearly all of this job. At around 25 referrals per session and a few
   sessions a week, a run is dozens of rows. Batching is for resumability and the Sheets write
   quota, not to stay inside a CPU budget.
5. **Sheets write quota** is per-minute (roughly 60 write requests per user, 300 per project). Append
   a page's rows in one `values.append` call rather than one call per row.

## What is not settled

- **Whether personal fields go in the Sheet at all** — `OPEN-QUESTIONS.md` **Q24**, and it blocks
  building the row shape. Pete leans towards not copying names and addresses, but it is the
  charity's decision and this repo does not settle those.
  _(Settled 2026-08-05: **every referral on the session goes across, whatever its status** — active,
  cancelled, rejected and `pending_review` alike. Review is an optional step, so `pending_review` is an
  ordinary state rather than an unfinished one, and a rejected referral has to live somewhere. The
  status is a column; nothing is filtered out.)_
- **The schedule.** Anything from hourly to daily meets the requirement.
- **Which spreadsheet.** Its id is configuration, and someone has to share it with the service
  account's email address before the first run.

## Two rules the export leans on

- **Once a session is confirmed, no further changes can be made to it.** Without this, a referral
  moved off a confirmed session exports under the old session and again under the new one — one
  household, two rows, and the marker cannot prevent it because it sits on the session.
- **A session cannot be cancelled while anybody still holds a place on it.** With it, a cancelled
  session never has referrals on it, so there is nothing on one to export and "should a called-off
  session reach the Sheet?" stops being a question. Exporting only on confirmation is complete rather
  than complete-by-assumption.

Both are in `INITIAL_SPEC1.txt` and **neither is enforced by the code today**. The diagnosis and the
fix for each are in [`session-guards.md`](./session-guards.md); they are independent of this change
and should land first.

This one does more for the export than close a bug: **it means a cancelled session never has
referrals on it**, so there is nothing on it to export and the question of whether a called-off
session should reach the Sheet does not arise. Exporting only on confirmation is complete, rather
than complete-by-assumption.

## What this adds

A second cron trigger next to `17 2 * * *` in `wrangler.jsonc`, a branch in the `scheduled` handler
on `event.cron`, a job module, an `exported_at` column on `sessions` with a partial index on
`WHERE exported_at IS NULL`, two secrets, and export mappers.

`exported_at` is a nullable timestamp and holds no personal data, so it is a one-line migration
rather than a table rebuild. It goes on `sessions`, which keeps it off the table holding the PII
block — a small bonus of putting the marker on the session.

Closing the confirmed-session gap above is a separate, smaller change and does not have to wait for
the export.

No new API routes are required — the job reads through services in-process. If the charity later
wants the extract on demand as well, an admin trigger route is the pattern already used by session
materialisation.
