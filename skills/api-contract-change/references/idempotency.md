# Idempotency For Side-Effecting Requests

Clients retry. Networks drop responses, mobile apps get killed mid-request, gateways time out and
replay. Any `POST` with a side effect (create, pay, publish, grant, send) must be safe to repeat.
The mechanism has five parts; skipping any one reintroduces duplicates or silent wrong answers.

## 1. A required idempotency key

- The client generates a stable logical identity for the user action (one per intent, reused on every
  retry of that intent) and sends it as an `Idempotency-Key` header.
- **Missing or blank key -> HTTP 400 with your own error code**, not the framework's default
  validation status (often 422). Retry logic and dashboards key off the status; a generic validation
  error hides "client forgot the key" among genuine payload bugs. Declare the header as optional at
  the framework level and enforce presence yourself so the failure shape is yours. Also bound the
  key length.
- Scope the key to the actor and operation kind (`actor + kind + key`). Two users reusing "abc" must
  never collide.

## 2. Payload fingerprint -> 409 on mismatch

Store, with the key, a hash of the **canonicalised** request payload (sorted keys, no insignificant
whitespace, stable number/date formats, aliases applied). On a repeat:

- same key + same fingerprint -> return the original result (a true replay);
- same key + **different** fingerprint -> **409 Conflict**, never the old result and never a fresh
  execution. Returning the old result would tell the client "your new request succeeded" when it did
  nothing; executing again would break the key's meaning. Either way a client bug (key reuse) would be
  masked instead of surfaced.

```python
def fingerprint(payload: dict) -> str:
    canon = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canon.encode()).hexdigest()

existing = await repo.get(actor, kind, key_hash)           # under a per-key lock
if existing:
    if existing.fingerprint != fp:
        raise ApiError(ErrorCode.CONFLICT, "key already used with a different payload")
    return existing.response
```

```ts
const fp = sha256(stableStringify(payload));               // stableStringify sorts keys recursively
const row = await repo.get(actor, kind, keyHash);          // inside a transaction with an advisory lock
if (row && row.fingerprint !== fp) throw new ApiError(409, CONFLICT, "key reused with different payload");
if (row) return row.response;
```

## 3. Cache only committed results; the durable store is the truth

- The authoritative record lives in the database and is written **in the same transaction** as the
  business write, so "result exists" and "effect exists" are one fact. Concurrent duplicates serialise
  on a per-key lock (advisory lock or unique constraint).
- A fast cache (Redis etc.) may sit in front, but it stores only **completed, committed** responses,
  and only after commit. Never cache "in progress" or pre-commit state: a crash between cache write
  and commit would replay a result for an effect that never happened.
- Cache failure or a corrupt cache value is a miss: fall back to the durable store. Cache is an
  optimisation and its outage must not change correctness.
- If the **durable** idempotency read fails (store unavailable), **fail closed with 503**. Treating
  "could not look it up" as "first request" is how users get charged twice.

## 4. Derive audit identity from the key

Audit/history rows get a deterministic primary key derived from `action + actor + idempotency key`.
A replay recomputes the same key and collides with the first write, so deduplication is automatic and
needs no extra check. Consequence to document: one key supports exactly one audit write per action;
a batch that writes one audit row per target must derive per-target keys (`f"{key}:{target_id}"`),
otherwise all but the first row are swallowed as "replays". Never fabricate the key from an actor id
or a random number; that defeats the purpose.

## 5. Client side: replay only what is safe

The shared transport may automatically retry/replay a request only if it is `GET`/`HEAD`, or a `POST`
that carries an idempotency key. Everything else is surfaced to the caller.

```ts
export function isReplaySafeRequest(method: string, headers: Record<string, string>): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  return Boolean(headers["idempotency-key"]?.trim());       // POST replay is opt-in via the key
}
```

The same rule applies server-to-server: a retry policy attached to a non-idempotent outbound call is a
bug (see the provider-gateway skill).

## Tests to require

- Replay returns the identical response; side effect count stays one.
- Same key, different payload -> 409.
- Cache down -> still correct via durable store; durable store down -> 503, no side effect.
- Missing key -> 400 with the project's own code.
- Two concurrent requests with one key -> one effect.
