# Outbound HTTP: Single Source, Named Timeouts, Retry Policies

## Single client factory

All outbound HTTP goes through one gateway module that owns: TLS trust setup, destination policy
(SSRF defence), correlation-header propagation (request id, trace id), and connection pooling.
Business and adapter code import the factory, never the HTTP library's client class.

**Enforce by static scan**, not by review. Parse each file in the provider/core trees, collect import
aliases of the HTTP library (`import httpx as h`, `from httpx import AsyncClient as C`), and flag any
call that constructs a client, outside the gateway directory.

```python
for node in ast.walk(tree):
    if isinstance(node, ast.Call) and is_direct_client_ctor(node, module_aliases, client_aliases):
        findings.append((node.lineno, "create clients via the gateway factory"))
```

```ts
// ESLint no-restricted-syntax / no-restricted-imports: ban `new Agent(...)`, `axios.create`,
// and direct `undici`/`axios`/`got` imports outside src/core/http-gateway/**
```

Also add a class-level test that the gateway has exactly one implementation (a second place that
builds clients, or a differing binding in a sibling service, turns the test red). Shared behaviour
lives in a shared package; each service's binding only injects its own hooks.

## Named timeout tiers

Do not scatter `timeout=5.0` literals. Define a few tiers named by **what the caller is waiting for**,
not by vendor:

| Tier | Meaning | Example value |
| --- | --- | --- |
| interactive | a user is waiting; fail fast and degrade | a few seconds |
| exchange | a heavier handshake (token exchange, verification) | somewhat longer, still below the gateway's overall timeout |
| batch / background | nobody waiting | larger, still bounded |

Values are examples; choose yours and keep them in one module. A guard test rejects numeric-literal
`timeout=` in client constructor calls (legacy sites live in a baseline that only shrinks).

## Retry as a policy object

```python
@dataclass(frozen=True)
class RetryPolicy:
    name: str
    max_attempts: int            # total attempts including the first, >= 1
    base_seconds: float
    cap_seconds: float
    jitter: bool                 # full jitter: uniform(0, ceiling)
    retryable_statuses: frozenset[int] = frozenset()   # empty = transport failures only
```

```ts
interface RetryPolicy { name: string; maxAttempts: number; baseMs: number; capMs: number;
                        jitter: boolean; retryableStatuses: ReadonlySet<number> }
```

- Policies are registered in one place; backoff time is computed by one function (honour upstream
  `Retry-After`, but cap it).
- A policy states which failures are retryable. Deterministic rejections (400/401/403/404) are never
  retried; retrying them only multiplies the error.
- **Non-idempotent calls must not be attached to a retry policy** (payment creation, refund, sending a
  message) unless the call carries an idempotency key the upstream honours. Retry belongs to idempotent
  reads/queries and explicitly replay-safe calls.
- Retries live in the adapter/boundary that understands the provider's failure modes, never in route
  handlers.
