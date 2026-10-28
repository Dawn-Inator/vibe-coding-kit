# Schema Surfaces And Client Reconciliation

Two mechanisms that keep the schema artifact honest: separate public/internal artifacts, and a
two-way reconciliation between the schema and every client.

## 1. Two artifacts: public and internal

- **Public artifact**: everything front-end clients may call. It must contain **no** internal route.
  The generator filters, and a post-generation assertion fails the build if one slips through.
- **Internal artifact** (a separate file): the east-west contract for service-to-service consumers.
  It is the source for generated internal client models, so internal callers get types without the
  public pipeline ever seeing the routes.
- **Segment-based predicate.** Internal means `path == PREFIX or path.startswith(PREFIX + "/")`.
  Never a bare `startswith(PREFIX)` (a public `/api/v1/_internalfoo/x` is then hidden from the public
  artifact) and never a substring test. Share the predicate with the auth gate (one source).
  Remember OpenAPI paths are templates (`/x/{id}`), so do not use a full-match regex either.
- **Unexportable internal routes.** Occasionally a route's models cannot be turned into schema.
  Do not drop it silently: keep an explicit allowlist of `(METHOD, path)` pairs. The generator probes
  each internal route individually and requires the failing set to equal the allowlist exactly. When
  a route becomes exportable, the generator **fails until you delete the entry**, so the list can only
  shrink.

```python
def is_internal_api_path(path: str) -> bool:
    return path == INTERNAL_API_PREFIX or path.startswith(INTERNAL_API_PREFIX + "/")

public_paths = {p: v for p, v in paths.items() if not is_internal_api_path(p)}
```

```ts
const isInternalApiPath = (p: string) => p === PREFIX || p.startsWith(PREFIX + "/");
const publicPaths = Object.fromEntries(Object.entries(paths).filter(([p]) => !isInternalApiPath(p)));
```

Internal routes are often mounted with schema inclusion off so the public generator cannot see them;
the internal generator re-enables them on a throwaway app instance rather than flipping the flag in
the real app.

## 2. Client <-> schema reconciliation

A schema nobody checks against the clients drifts both ways. Write a checker that reads the schema
artifact(s) and the client wrappers (and front-end sources), and fails on:

1. **Method mismatch**: the wrapper calls `GET` where the schema says `POST` (or vice versa).
2. **Phantom route**: the wrapper calls a path that does not exist in the schema. A budget of
   known-missing routes may exist in an allowlist, but the budget only shrinks (start it at zero if
   you can).
3. **Orphan endpoint**: a public endpoint with no consumer ownership. Every public endpoint is
   assigned to exactly one owner set such as `mobile`, `web`, `admin`, or `none`. `none` needs a
   per-entry `reason`, `owner`, `expiry`, and `removal_plan`; it is where webhooks, ingestion
   endpoints and machine-to-machine callers live, visibly.
4. **Hard-coded prefix strings**: front-end application code containing a literal API prefix
   (`"/api/v1/..."`) instead of going through the typed client. Scan app sources (comments excluded);
   allowlisted exceptions carry the same metadata.
5. **Stale allowlist rows**: entries whose endpoint is now compliant must be deleted.

Sketch of the core loop (Python):

```python
for call in extract_client_calls(client_root):            # (method, normalised_path)
    route = schema.get(call.path)
    if route is None:      fail(f"phantom route {call.path}")
    elif route.method != call.method: fail(f"method mismatch {call.path}")
for route in schema.public_routes():
    if route.key not in owners_union: fail(f"no consumer owner: {route.key}")
```

TypeScript variant: parse client wrapper call sites with the compiler API (or a codegen manifest) and
compare to the parsed schema in a Node script run by the same CI step.

Normalise paths on both sides before comparing (strip the version prefix, collapse path parameters).
Sibling services that publish their own public schema should be discovered by glob, not by a copied
list, so a new service cannot be forgotten.
