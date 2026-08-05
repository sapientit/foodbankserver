---
paths:
  - 'src/modules/auth/**'
  - 'src/modules/users/**'
  - 'src/http/middleware/**'
---

# Authentication rules

What the charity asked for is in `INITIAL_SPEC1.txt` under `#Login`. This file is how it is
enforced. Longer rationale: [`docs/architecture/authentication.md`](../../docs/architecture/authentication.md).

- **A sign-in lasts eight hours and nothing extends it** (`SIGN_IN_TTL_SECONDS`). The first refresh
  token of a family carries the instant the sign-in ends and **every rotation copies that value**
  rather than computing a new one. That inheritance is the whole mechanism: a rotation that writes
  `now + TTL` silently turns an absolute cap into an idle timeout. Access tokens are capped at the
  same instant — `signAccessToken` takes it as a **required** argument so it cannot be forgotten.
- **Access tokens are stateless HS256 JWTs**, 15 minutes, verified in `token.service.ts` (pure — no
  database, no HTTP). Verification costs zero queries, which is the point on a 50-query budget.
- **Refresh tokens are opaque, rotating, and stored only as a SHA-256 hash.** Presenting an
  already-rotated token is **refused and nothing more** — logged by user id, sign-in carries on.
  `revokeFamily` belongs to logout and deactivation only. Do not reintroduce family-wide revocation
  on replay; that was decided against deliberately.
- Refresh token travels in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/v1/auth`.
  The access token goes in the response body for the frontend to hold **in memory only**.
- **Logging in never creates an account.** `resolveUser` refuses an unknown email with the _same_
  error as a bad credential, so a caller cannot learn which addresses are registered. **No provider
  may provision, including the dummy one.**
- **The dummy provider has no validation, as specified.** Two structural controls carry the safety:
  the dev-login route is _not registered_ unless `AUTH_MODE=dummy`, and the Worker refuses to boot
  with `AUTH_MODE=dummy` in production. Anyone who knows an admin's address can be that admin, so
  real referral data must never live in such a deployment.
- **Users are never deleted** — the ledger, audit events and attendance name them. `isActive: 0` is
  the retirement path, and email is not amendable (it is the login identity and what the audit trail
  means by "who"). Two lockouts are refused: demoting or deactivating **yourself**, and doing either
  to the **last active admin**. The second cannot be a count-then-write — `updateLeavingAnotherAdmin`
  carries the condition into the `UPDATE` and the service reads the result.
- Use `requireAuth` then `requireRole('admin')`. **Name roles explicitly per route**; never invent a
  hierarchy where `team_lead` is "a lesser admin".

## Route mounting — this one is a trap

**Never use `routes.use('*', requireAuth)` in a sub-app mounted at the shared `/api/v1` prefix.** A
wildcard `use` there applies to every path under the prefix, not just that sub-app's routes: it
turns unmatched paths into 401s instead of 404s and would **silently require authentication on any
public route mounted after it**. Attach middleware per route —
`routes.get('/sessions', ...readers, handler)` — which also puts the access level next to the thing
it protects. `test/route-mounting.test.ts` guards this.
