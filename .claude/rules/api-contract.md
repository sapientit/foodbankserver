---
paths:
  - 'openapi.yaml'
  - 'API.md'
  - 'src/app.ts'
  - 'src/modules/**/*.routes.ts'
  - 'src/modules/**/*.mapper.ts'
  - 'scripts/check-openapi.mjs'
---

# Client contract rules

The separate React frontend generates its types from `openapi.yaml`, so **the spec is part of the
API, not documentation about it.** `openapi.yaml`, `API.md` and `OPEN-QUESTIONS.md` are the whole
channel between the two repos; there is no direct conversation between the assistants, by design.

- **Change a route and the spec changes in the same commit.** That is what `npm run check:openapi`
  exists to force.
- The check fails on: a route missing from the spec, a spec path nothing serves, a `$ref` pointing
  at nothing, and **a schema typed `object` that does not say which fields it holds** (name them,
  `$ref` a component, compose with `allOf`, or declare `additionalProperties`). A propertyless
  object is valid OpenAPI that generates an unusable type — `PATCH /recurring-sessions/{id}` shipped
  that way and the empty type hid a schema bug that reset a template's capacity on every amendment.
- It is text-only and dependency-free. Keep it that way so CI needs nothing extra.
- It does **not** check field names or types beyond that shape rule.

## Response mappers are the output allowlist

Hono has no response-schema mechanism. Every route returns through an explicit `toXxxResponse()`
mapper with a declared narrow return type. **That mapper is what stops a newly added column leaking
to a role that should not see it** — adding a field to a table must never widen an API response by
accident. A mapper change that widens a response is a review question, not something the contract
check catches.

## Routes

- Plural nouns under `/api/v1`: `/sessions/:sessionId/pick-list`.
- Verbs go in the method, except genuine state transitions, which may be a sub-resource:
  `POST /pick-lists/:id/confirm`.
- Routes are HTTP only — parse, authorise, call the service, map the response. **No business rules.**

## Errors

- Throw the typed errors in `core/errors.ts`; `http/error-handler.ts` maps them to status codes and
  a consistent body.
- `ConflictError` for "wrong state" (pick list already confirmed); `UnprocessableError` for "a rule
  forbids this" (insufficient stock). The distinction matters to the UI.
- Anything else escaping a handler is a bug: logged in full, returned as an **opaque 500**. Never
  hand a client a stack trace, a SQL string or an internal message.
