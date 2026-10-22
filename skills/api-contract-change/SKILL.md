---
name: api-contract-change
description: Govern this project's public API contract changes. Use when adding or changing a backend endpoint, public path or method, request or response DTO, status or error semantics, authentication policy, OpenAPI artifact, generated API type, or API-client wrapper.
---

# API Contract Change

This skill has two parts: (1) a generic contract-change discipline that applies regardless of which
URL/method convention you pick, and (2) a concrete, ready-to-adopt RPC-over-HTTP convention (below,
"RPC Shape Reference") you can use as-is or replace with your own. Either way, **write your convention
down once and machine-enforce it** — a convention that only lives in people's heads erodes within a few
months of multi-author, multi-AI-session development.

If you already have an established API convention (REST, GraphQL, gRPC, ...), keep it and skip the RPC
Shape Reference section — the discipline in sections 1-3 still applies.

## 1. Discover Authority And Surface

- Classify the change as public (`/api/v1/*` or equivalent), backend-internal, or a private-service
  contract.
- For public APIs, pick **one file** as the OpenAPI/schema artifact authority and **one file** as the
  shared client-type authority (generated from it). Never hand-edit either — regenerate them from the
  route/handler code instead. Fill in your project's actual paths here once you've decided them, e.g.:
  - artifact authority: `<your backend app>/openapi.json` (or equivalent)
  - generated client-type authority: `<your shared types package>/generated/api.ts` (or equivalent)
- Keep internal/private endpoints out of the public artifact. If your project has both a public and an
  internal surface, verify the internal one isn't accidentally exposed through the same generator, and
  test it with focused contract tests rather than through the public type-generation pipeline.
- Locate every API-client wrapper and direct consumer before changing a path, DTO, status, or semantic.
  Preserve an existing public facade unless an approved contract change explicitly replaces it.

## 2. Define The Compatible Contract

- Keep public routes on your chosen URL/method convention (see "RPC Shape Reference" below, or your
  own). Identify an incompatible consumer change **before** implementation; do not silently add an
  alias or change a public URL to paper over it.
- Declare request and response DTOs, success and failure status, and error-code semantics together, in
  the same change. Map domain/provider failures to stable public errors; never expose exception text,
  SQL, credentials, stack traces, or raw provider payloads to a public consumer.
- Set explicit authentication policy per operation. `required` should be the default; an `optional` or
  `public` operation, or any policy downgrade, should require a deliberate, reviewed decision — auth
  policy should only ever get stricter over time by default, never quietly looser.
- Keep hand-written consumer wrappers and domain schemas aligned with the generated public DTOs, but
  don't let a hand-written schema silently substitute for (and drift from) the generated one.

## 3. Regenerate And Validate

For a public-contract change, regenerate and commit the artifacts together with the implementation —
never in a follow-up commit, or the two drift the moment anyone forgets step 2. Fill in your project's
actual commands once you have them, e.g.:

```bash
<your OpenAPI/schema regeneration command>
<your generated-client-type regeneration command>
<your docs-impact / affected-docs check, if you have one>
```

- Review the OpenAPI (or equivalent) and generated-type diffs for unintended paths, schemas, auth
  metadata, or encoding changes. Update the affected API-client wrapper and its consumers in the same
  change.
- Run focused backend contract/auth tests and affected API-client or consumer tests. Add a regression
  contract test for a changed compatibility, auth, or error boundary — this is the same "two-layer
  regression" discipline as [bugfix-regression-tests](../bugfix-regression-tests/SKILL.md) applied to
  contract changes specifically.
- Update your API contract doc (if you have one) whenever a public artifact, generated type, wrapper,
  or public semantic changes; ordinary implementation-only bug fixes don't need a docs update.
- When adding or changing a path segment, enum value, or parameter value, check it against
  [repository-layout](../repository-layout/SKILL.md)'s "业务标识符命名" rule: it must be a readable
  semantic name, never a sequence number or positional code (`n1`, `step2`, `a`/`b`, ...).

## RPC Shape Reference (a ready-to-adopt default convention)

This is the actual convention used in the project this starter kit was extracted from — a genuinely
usable default if you don't already have a strong API-style opinion, not just an illustrative example.
It deliberately drops RESTful method semantics in favor of RPC-over-HTTP: **`GET` and `POST` only** —
`PUT` / `PATCH` / `DELETE` are forbidden. The value of this convention is that it's trivial to
machine-enforce (a router-contract checker just needs to reject any other HTTP method and validate the
URL shape below against a regex), which is the whole point — a convention nobody can violate by
accident governs code far more reliably than a convention that only lives in a code-review checklist.

### URL forms

```
/api/{version}/{service}/{module}/{object}/{action}
/api/{version}/{service}/{module}/{object}/{id}/{action}
/api/{version}/{service}/{module}/{object}/{id_1}/.../{id_n}/{action}
/api/{version}/{service}/{module}/{action}
```

- `{version}`: `v1` / `v2` …
- `{service}` / `{module}` / `{object}`: the three business segments. In the original project these
  mapped 1:1 to the backend's package path (e.g. `app.service.<service>.<module>.<object>`) — adopt
  the same 1:1 mapping to your own code layout if you can, since it means anyone reading a URL can find
  the handler without grepping. `{object}` may be omitted only in the rare "directly under module" case.
- `{action}`: a **single** lowercase underscore verb stating what this call does. Multi-segment actions
  such as `bulk/xxx` are forbidden — invent a single verb instead (`bulk_create`, not `bulk/create`).
- `{id}` / `{id_1}..{id_n}`: optional resource identifiers; multi-id cases (e.g. group membership) may
  chain segments, ordered outermost to innermost.

Examples:

```
POST /api/v1/shop/product/create
POST /api/v1/chat/message/id_187816/edit
POST /api/v1/messaging/group/member/thread_abc/user_xyz/remove
GET  /api/v1/content/item/feed/list
POST /api/v1/content/interaction/like/id_abc/add
```

### GET vs POST

- `GET`: side-effect-free reads (list / detail / search). Parameters go in the query string.
- `POST`: writes, state changes, anything with side effects. Parameters go in the JSON body.

**Exception — read-only queries that grow linearly with the session.** When a read parameter
accumulates across a user session and can exceed the ~8KB HTTP request-line limit, that list endpoint
may use POST + body instead. Real example this convention was built around: a feed-dedup endpoint
carrying `excludeIds: string[]` that accumulates as the user scrolls — a GET with those IDs as a query
string hits HTTP 414 at roughly 200-300 entries. Both tests must hold before you reach for this
exception: (1) the parameter genuinely grows with session state by nature, not just "it's convenient";
(2) there is no state-changing side effect. Register each such exception explicitly (a small allowlist
in your router-contract checker) — this is not a default escape hatch, and a new POST "read" endpoint
without a registered exception should fail the governance check.

### Action vocabulary

Reuse a shared vocabulary before inventing a new verb — externalize it into a small registry file your
governance check can read, rather than letting every author invent their own synonyms:

- Read: `list` / `detail` / `search` / `query` / `export` / `summary`
- Write: `create` / `update` / `delete` / `edit` / `submit`
- Relations: `add` / `remove` / `accept` / `reject` / `approve`
- State transitions: `publish` / `release` / `claim` / `refund` / `read` / `moderation`

Keep action naming consistent within one object — don't mix `like`/`unlike` in one place with
`add`/`remove` in another for equivalent relations elsewhere in the same API.

### Scope

- Decide up front which prefix marks "internal, not part of the public contract" (e.g. `/api/v1/_internal/*`)
  and enforce that internal endpoints only ever live behind it — judge this by prefix match, not by a
  substring check, so `/api/v1/internal_reports/list` doesn't accidentally get treated as internal.
- All public business endpoints should comply with the naming rules above; internal endpoints are out
  of scope for the naming rules but should still declare an explicit auth policy (section 2).

### Building the machine-enforced check

The value of this whole convention collapses if it's only enforced by code review. Build a small script
(in whatever language your backend is written in) that:
1. Walks every registered route.
2. Rejects any HTTP method other than `GET`/`POST`.
3. Validates the URL shape against the pattern above (regex is enough).
4. Cross-checks `{service}/{module}/{object}` against your actual code package path, if you adopted the
   1:1 mapping.
5. Checks the `{action}` verb against your action-vocabulary registry, flagging new verbs for review
   rather than silently accepting them.

Wire it into your test suite so a violating route fails CI, not just a human reviewer's attention span.

## Stop And Escalate

Stop for direction when existing consumers cannot remain compatible, a public/internal classification is
unclear, an auth policy is being weakened, or a proposed error could reveal protected information.
