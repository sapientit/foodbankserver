# Authentication design

The mandatory rules are in [`.claude/rules/authentication.md`](../../.claude/rules/authentication.md).
What the charity asked for is `#Login` in `INITIAL_SPEC1.txt`. This file is the reasoning.

## Why the sign-in cap is inherited rather than recomputed

A sign-in lasts eight hours, absolute, counted from the moment of signing in. The obvious
implementation — give each refresh token an eight-hour life — quietly produces an _idle_ timeout
instead, because every rotation would push the end further out and a user who keeps working would
never be signed out.

So the first refresh token of a family carries the instant the sign-in **ends**, and every rotation
copies that value. `signAccessToken` takes the same instant as a **required** argument and issues
`min(now + 15m, signInExpiresAt)`, so the last access token of a sign-in is a short one rather than
one that outlives the cap by up to fifteen minutes. The refresh cookie's `maxAge` is the remaining
seconds, not a fresh eight hours.

The inheritance is the whole mechanism. A rotation that computes `now + TTL` looks correct, passes a
naive test, and silently changes the product behaviour the charity asked for.

## Why replay no longer revokes the family

The original design treated a re-presented refresh token as theft and revoked the entire family,
signing the legitimate holder out everywhere. That is the textbook response, and the charity decided
against it: a repeated request is far more often a client that retried on a bad warehouse connection
than a stolen token, and signing somebody out of every device on that evidence disrupts the charity
more than the thing it guards against.

So a spent token is refused and nothing more — logged by user id, sign-in carries on. `revokeFamily`
now belongs to logout and deactivation, both of which are somebody's decision rather than an
inference from a repeated request. `replay_detected` survives in `REVOKED_REASONS` and the CHECK
constraint because dropping a value costs a table rebuild and old rows still carry it.

## Why stateless access tokens

Verification costs zero queries, which matters on a 50-query-per-invocation budget. The cost is that
**deactivating a user does not revoke their access token** — they lose access at the next refresh,
so within fifteen minutes. Immediate lockout would need either a query per request (the thing
stateless JWTs exist here to avoid) or a revocation list. Neither is worth it until someone asks.

## Why logging in never creates an account

A provider says who somebody is; the `users` table says whether this food bank has granted them
access and as what. Keeping those separate is what makes the identity provider swappable: **swapping
in Google means adding one file.** `identity-provider.ts` defines the contract and everything
downstream of `IdentityClaim` is provider-agnostic. `users.google_subject` already exists, and
because neither provider provisions, Google inherits the right behaviour by default rather than by
remembering to switch a flag off.

`resolveUser` refuses an unknown email with the _same_ error as a bad credential, so an
unauthenticated caller cannot enumerate which addresses are registered.

## The bootstrap admin

`migrations/0007_bootstrap-admin.sql` seeds the first admin, because a database where logging in
cannot create an account otherwise has nobody who can create one. It is `ON CONFLICT DO NOTHING`, so
a re-run never resurrects an account somebody has since deactivated. It is data rather than schema,
so it is hand-written and its drizzle snapshot is a copy of the previous one.

`pete@x.com` is a stand-in and is **replaced when Google auth lands** — that is Pete's answer, not an
assumption, and it is recorded in the migration and in `identity-provider.ts` so whoever does the
Google work meets it.

## The dummy provider

It has no validation, as specified — any address is accepted as proof of identity. It is not a way
in, since the address must already be a user, but two structural controls carry the safety:

1. the dev-login route is **not registered** unless `AUTH_MODE=dummy`;
2. the Worker **refuses to boot** with `AUTH_MODE=dummy` in production.

Anyone who knows an admin's email address can be that admin, so real referral data must never live
in such a deployment.
