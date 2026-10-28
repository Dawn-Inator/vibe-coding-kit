# East-West Client And Tolerant Reader

## Internal client base

Service-to-service calls get their own typed client base, distinct from the third-party provider
gateway. Responsibilities:

- **Workload identity is injected automatically.** The client mints a short-lived token scoped to the
  target (audience) and operation (scope) and sets `Authorization` itself. Callers **cannot override**
  `Authorization`; a caller-supplied header with that name raises. Missing token configuration fails
  the call instead of sending it unauthenticated.
- **Path shape allowlist.** Path parameters often come from external input; validate the final path
  against a per-target pattern before sending (reject `../`, absolute URLs, `?`/`#`, double slashes).
  Match on prefix/segments, not substrings. Prefixes differ per target; do not use one regex for all.
- **Circuit breaker**: when open, fail fast with an "unavailable" contract error rather than queueing
  more calls at a sick peer. Record outcomes (transport errors, 5xx) into it.
- **Process-level connection pool** per target, reused across requests, with configured limits and
  keep-alive expiry. Do not create a client per call.
- **Errors converge** into a small set of contract exceptions (rejected vs unavailable) so callers
  decide degrade-or-propagate without parsing HTTP.

```python
headers = {"Authorization": f"Bearer {issue_token(target=self.target, scope=scope)}"}
if any(k.lower() == "authorization" for k in caller_headers):
    raise InternalCallError("caller cannot override workload Authorization")
breaker = self._breaker()
if not breaker.allow():
    raise InternalServiceUnavailable(f"circuit open: {self.target}")
```

```ts
if (Object.keys(callerHeaders).some((k) => k.toLowerCase() === "authorization"))
  throw new InternalCallError("caller cannot override workload Authorization");
if (!breaker.allow()) throw new InternalServiceUnavailable(`circuit open: ${target}`);
const res = await pool(target).request({ ...req, headers: { ...callerHeaders, authorization: `Bearer ${await issueToken(target, scope)}` } });
```

### Destination policy is directional (a real failure)

External provider calls and internal calls need **opposite** destination policies. Third-party calls
should allow public addresses only (SSRF defence). Internal calls should allow only loopback/private/
link-local and reject public addresses. In one codebase the internal client reused the provider
policy function; the only private exception it knew was loopback, but in the dev environment the peer
service was reached through a container bridge gateway address in the private range. Result: every
internal call (including money-moving ones) was blocked as "SSRF" while the network was perfectly
healthy, and it persisted from first deploy because the failure looked like a security refusal rather
than a bug. Lessons: give internal calls their own explicit policy constant instead of reusing the
provider one; do not "fix" it by loosening the provider policy (that opens real SSRF); add a test that
exercises the internal client against a private non-loopback address.

## Tolerant reader (liberal in what you accept)

A strict decoder makes a peer's additive release break you, and one malformed list item can take down
a whole page. Pair the strict whole-envelope decoder with a tolerant one for read paths where partial
data beats no data:

- **Unknown fields**: ignore (`extra="ignore"` / non-strict object parsing). A peer shipping a field
  first is not an error.
- **Unknown enum values** in classification fields: map to an explicit sentinel (`"unknown"`), log the
  raw value, keep the item.
- **Lists**: validate item by item; drop a bad item, emit a structured warning and a counter, keep the
  rest.
- **Envelope-level breakage** (data not an object, list field not an array): still fail the whole call
  with the "unavailable" contract error; the caller chooses degrade or propagate.
- **Money and authorisation paths opt into `fail_closed`**: any invalid item or unknown enum raises,
  and extra fields are not tolerated. Never let a tolerant default decide a balance, a permission, or
  a price.
- Make tolerance declarative per call site (a policy object naming the lists and the sentinel enums)
  and test each rule.

```python
@dataclass(frozen=True)
class TolerantPolicy:
    target: str
    endpoint: str
    lists: tuple[TolerantList, ...]
    fail_closed: bool = False        # True for money/authorisation reads
```

```ts
const policy = { target: "billing", endpoint: "/_internal/plan/list", lists: [planList], failClosed: false };
const result = decodeTolerant(policy, json);   // drops bad items, logs + counts, maps unknown enums to "unknown"
```

## Generated internal models need a freshness test

Consumer-side models are generated from the **owner's** internal schema artifact and never hand
edited. Put a header in every generated file naming the source of truth and the regeneration command,
and add a freshness test that regenerates in memory (or hashes the source schema) and fails when the
owner's schema changed without regenerating. Regeneration is part of the owner's change, and the
consumer's CI catches a forgotten one.
