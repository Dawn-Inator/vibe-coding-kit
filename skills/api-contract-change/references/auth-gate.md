# Authentication Gate: Implementation Shape

Goal: every endpoint either proves it is authenticated, or appears in a reviewed allowlist. "Proves"
means a static check, not a naming guess. This file covers the mechanism, the invariants, and the
machine enforcement. Examples use FastAPI-style dependency injection; the same idea applies to
Express/Nest middleware chains, Spring annotations, and so on.

## Invariants

1. **Three policies only**: `required` (default), `optional` (guest allowed, enhanced when logged in),
   `public` (no identity at all). `optional` and `public` are downgrades and each lives in its own
   allowlist file.
2. **Trust is by import source, not by name.** A dependency named `require_*` proves nothing
   (`require_feature_enabled` is a feature flag, not auth). Keep an explicit table
   `canonical.module.symbol -> policy`; a new auth dependency is added there only after security
   review. An `optional` dependency must never be accepted as `required`.
3. **Allowlist entries carry review metadata**: `reviewed_by`, `reviewed_at`, `reason` (plus an issue
   link if you have one). An entry without them fails the gate. Adding an entry, or moving an endpoint
   from required to public/optional, is a security-review event in the same change.
4. **The "unauthenticated baseline" is empty** and stays empty. It exists only so the checker has a
   ratchet file; the correct fix for a finding is to add auth or to add a reviewed public entry, never
   to grow the baseline.
5. **Fail closed on what you cannot see.** If the checker cannot statically decide, the answer is
   "unauthenticated", not "probably fine".

## Recognise every way a dependency can be attached (AST)

A checker that only matches `Depends(name)` in a parameter default will silently miss the rest.
Resolve identifiers to their import source first (top-level imports only; an import inside a function
proves nothing about definition time), then recognise all of:

| Form | Python/FastAPI example |
| --- | --- |
| Parameter default | `def f(user = Depends(get_current_user))` (also keyword-only defaults) |
| `Annotated` metadata | `def f(user: Annotated[User, Depends(get_current_user)])` |
| Route-decorator dependencies | `@router.post("/x", dependencies=[Depends(require_admin)])` |
| Router-level dependencies | `APIRouter(dependencies=[Depends(require_admin)])` |
| Module-level alias of a factory result | `view = require_permission("report:view")` then `Depends(view)` |

The alias form is the dominant one for permission-scoped surfaces, and a name-only matcher never sees
it: collect module-level `name = trusted_factory(...)` assignments into the trusted-name set.

```python
def is_trusted_depends(node, trusted_names):
    if not isinstance(node, ast.Call) or call_name(node.func) != "Depends" or not node.args:
        return False
    dep = node.args[0]
    ref = dep.func if isinstance(dep, ast.Call) else dep
    return call_name(ref) in trusted_names
```

TypeScript/Node equivalent: use the TypeScript compiler API (or ts-morph) to walk route
registrations and check that the handler chain contains a middleware imported from the canonical auth
module, including a middleware stored in a `const authed = requireRole("x")` alias and middleware
passed to `router.use(...)` before the route.

```ts
// sketch: resolve the callee's import specifier, then compare to the trusted table
const source = resolveImportSource(callee, sourceFile);          // "src/auth/guards#requireUser"
const policy = TRUSTED_AUTH[source];                              // "required" | "optional" | undefined
```

## Dynamic registration: fail closed

`app.add_api_route(...)`, `router.api_route(...)`, `app[method](path, ...)` with a computed method, or
routes generated in a loop cannot be inventoried statically. Do not skip them. Report them as
violations and require rewriting to an explicit per-method decorator/registration so they enter the
inventory. The same goes for an incomplete scan: if the import graph cannot prove which modules are
in the production scope, block the verdict instead of scanning "what we found".

Scan every HTTP verb the framework supports, not only the ones your convention allows. If someone
adds `PUT` and the route-shape gate is later bypassed, the auth gate must still see the route.

## Internal-surface exemption: prefix match only

Routes under the east-west prefix are exempt from user-auth rules because they follow a workload-token
check validated separately. The predicate must be a **path-segment prefix** (`== "/_internal"` or
`startswith("/_internal/")`), kept in one tiny zero-dependency module. Two historical bypasses to
rule out with tests: a file-name check (`"_internal" in filename` lets a public endpoint hide in
`foo_internal.py`) and a substring check (`"_internal" in prefix` lets `/user/my_internal_notes`
claim exemption). Add a repo-wide test that fails when any other code decides "is internal" by any
other method.

## Allowlist shape

```json
{
  "_meta": {"policy": "public", "reviewed_by": "<team>", "reviewed_at": "<date>",
            "change_policy": "additions need security review in the same change"},
  "public_endpoints": ["app/health.py::health", "app/webhook/router.py::receive_provider_event"]
}
```

Key by stable identity (`file::function`) rather than line number. Stale entries (endpoint removed or
now authenticated) must also fail, so the file shrinks as code improves.

## Wiring

Run in CI in strict mode on every change that can reach a protected branch; a local advisory mode that
always exits 0 is fine for developers but cannot be the only mode. Pair with a negative test: a fixture
endpoint with each of the five attachment forms passes, and the same endpoint with an untrusted
dependency, an `optional` dependency in a `required` slot, or a dynamic registration fails.
