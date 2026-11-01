---
name: api-contract-change
description: Govern this project's public API contract changes. Use when adding or changing a backend endpoint, public path or method, request or response DTO, status or error semantics, authentication policy, OpenAPI artifact, generated API type, or API-client wrapper.
---

# API Contract Change

This skill has two parts: (1) a generic contract-change discipline that applies regardless of which
URL/method convention you pick, and (2) a concrete, ready-to-adopt RPC-over-HTTP convention (linked below) you can use as-is or replace with your own. Either way, **write your convention
down once and machine-enforce it** — a convention that only lives in people's heads erodes within a few
months of multi-author, multi-AI-session development.

If you already have an established API convention (REST, GraphQL, gRPC, ...), keep it and skip the optional RPC reference — the discipline in sections 1-3 still applies.

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

- Keep public routes on your chosen URL/method convention (see the RPC reference below, or your own). Identify an incompatible consumer change **before** implementation; do not silently add an
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

## Optional RPC Convention

If the project adopts this convention, read the [RPC shape reference](references/rpc-shape.md); otherwise follow its existing API authority.

## Deeper Governance (read the reference for the topic you touch)

- Auth gate (AST detection of every injection form, fail-closed dynamic routes, reviewed allowlists, empty unauthenticated baseline): [references/auth-gate.md](references/auth-gate.md)
- Public vs internal schema artifacts; client <-> schema two-way reconciliation: [references/schema-surfaces-and-client-reconciliation.md](references/schema-surfaces-and-client-reconciliation.md)
- Envelope, pagination shape, segmented error codes, unknown-exception handling: [references/response-and-errors.md](references/response-and-errors.md)
- Idempotency for side-effecting POSTs (key, fingerprint -> 409, cache vs durable store): [references/idempotency.md](references/idempotency.md)
- Versioning cost, forced upgrade vs rollout, core/compat action vocabulary: [references/versioning-compat-and-actions.md](references/versioning-compat-and-actions.md)

Narrative walkthrough: `tutorial/06-codebase-architecture/api-idempotency-and-compat.md`.

## Stop And Escalate

Stop for direction when existing consumers cannot remain compatible, a public/internal classification is
unclear, an auth policy is being weakened, or a proposed error could reveal protected information.
