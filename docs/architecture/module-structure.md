# Module structure

```
src/
  worker.ts         entrypoint: default export { fetch, scheduled }
  app.ts            buildApp(): Hono<AppEnv> — no fetch binding, so tests can drive it
  config/env.ts     Zod over Worker bindings; the only place raw bindings are read
  core/             errors, branded ids, clock, log, time, crypto
  db/               client, schema/, expect helpers, unique-violation
  http/             context, cors, error handler, middleware
  modules/<name>/   one folder per domain area
```

## A module

| File              | Holds                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| `*.routes.ts`     | HTTP only: parse, authorise, call service, map response. No business rules.       |
| `*.service.ts`    | The domain logic. Knows nothing about HTTP, Hono, `Context`, request or response. |
| `*.repository.ts` | The storage interface the service needs, plus its Drizzle implementation.         |
| `*.schema.ts`     | Zod schemas and the types inferred from them.                                     |
| `*.mapper.ts`     | `toXxxResponse()` output allowlists.                                              |

**Dependencies point inwards: routes → service → repository.** A service that imports Hono's
`Context` is a bug — pass plain values and an `Actor` value object instead. Modules talk to each
other through services, never by reaching into another module's repository.

## Keep pure logic separable

Pure, I/O-free modules (`engine.ts`, `matching.ts`, `materialisation.ts`, `shelf-sort.ts`) carry the
highest-value tests in the codebase, and they only exist if the code is written to allow them. When
a rule can be expressed without touching the database, put it in one of these rather than inside a
service method.

## Why `buildApp` takes a config

**Which routes exist is a build-time decision.** The dev-login route is omitted entirely unless
`AUTH_MODE=dummy`, rather than registered and guarded — a route that does not exist cannot be
reached by a middleware ordering mistake. `requestContext` still loads config per request for
everything else; the two are not redundant, they answer different questions.

`buildApp` binds no fetch handler, so tests drive the whole stack through `app.request()`.

## Why the app is cached per isolate

`worker.ts` builds the app once per isolate (`app ??= buildApp(loadConfig(env))`) because
construction walks the whole route table, but not until the first request, because bindings are only
available then.

One consequence worth knowing when debugging: if construction throws once — a configuration
tripwire, a bad binding — that isolate keeps failing until it is recycled. A restart clearing a
persistent error is consistent with this and is not evidence that the error was transient.

## Validation and output

- Validate at the edge, once, with Zod, then trust the parsed type inwards.
- `unknown` at the boundary, a precise type after validation.
- Never trust a client-supplied id, role, quantity or status. **Re-derive parcel contents from
  household size on the server** — except the preference lines the client sends at pick-list
  generation, which are a deliberate, bounded exception because the client owns the referral form
  definition and the server holds none. The limits on it are in
  [`../../.claude/rules/pii-security.md`](../../.claude/rules/pii-security.md); do not widen them.
- Every response goes through an explicit mapper — see
  [`../../.claude/rules/api-contract.md`](../../.claude/rules/api-contract.md).
