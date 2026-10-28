# Versioning, Deprecation, Forced Upgrade, Action Vocabulary

## Version in the URL: know the cost

If the URL version segment and the code package map one-to-one (`/api/v2/x/y` <-> `service.x.y`),
every internal refactor that moves a package or renames an object is a **public breaking change**.
That coupling buys self-documenting routes and costs refactor freedom. It bites hardest when old
mobile builds stay online for months: you cannot ship a new path and delete the old one in the same
release, because installed binaries still call it.

Practical rules:

- **Keep legacy routes alive** for as long as supported client versions call them. A moved handler
  keeps its old path as a thin compat route, not a redirect that clients may not follow.
- **Compatibility budgets only shrink.** Track compat routes and compat actions in checked-in
  registries with a count budget; CI fails when the budget grows or an entry lacks an owner and
  removal plan. Removing a compat route requires evidence that no supported client version calls it
  (access-log or telemetry query by client version).
- Prefer additive change: new optional fields, new routes, widened enums handled by tolerant readers
  (see the provider-gateway skill) over in-place semantic change.
- Do not bump the URL version for a single route; bump it when the contract family changes.

## Forced upgrade vs staged rollout

A release record carries `version_code`, `min_supported_version_code`, `force_update`, and a rollout
percentage. Two separate questions:

1. **Does this client have an update?** `current < latest.version_code`.
2. **Must this client update?**
   `must_update = latest.force_update OR current < latest.min_supported_version_code`.

Staged rollout controls who is *offered* the update. Forced upgrade is the **emergency bypass** of that
control: when `must_update` is true, rollout percent and allowlists are ignored (the client is on a
version you no longer support or on a version with a known defect). Report the bypass reason in
telemetry.

```python
def evaluate_update(latest, current):
    if latest is None or current >= latest.version_code:
        return (False, False)
    return (True, bool(latest.force_update or current < latest.min_supported_version_code))

def eligible(bucket, percent, uid, allowlist, bypass):
    if bypass:                          return True
    if uid and uid in allowlist:        return True      # authenticated identity only
    return bucket < clamp(percent, 0, 100)
```

```ts
const mustUpdate = latest.forceUpdate || current < latest.minSupportedVersionCode;
const eligible = bypass || (uid != null && allowlist.has(uid)) || bucket < clamp(percent, 0, 100);
```

Invariants:

- The allowlist matches **authenticated user ids only**. An anonymous device id must never match it;
  device ids are spoofable and shared, and an allowlist hit grants early access. Pass `uid` and
  bucketing identity as separate parameters so the compiler/type checker keeps them apart.
- Bucketing is a stable hash of `release_id + identity`, so a given user does not flap in and out of
  the rollout. Anonymous callers still land in a stable bucket.
- Store only a hash of the identity in rollout events.
- The check endpoint itself must stay callable by the oldest supported build; never gate it behind a
  feature the old build lacks.

## Action vocabulary: core and compat tiers

Keep the allowed action verbs in a registry file the route checker reads. Each entry has a `kind`:

- `core`: the canonical vocabulary (list, detail, create, update, delete, add, remove, approve ...).
  Reusable by any new route.
- `compat`: verbs that exist only because older routes already use them. They are **route-level
  debt**: the registry records which existing routes use them, new routes must not, and the compat
  budget only shrinks as routes migrate to core verbs.

```json
{"actions": {"list": {"kind": "core", "reason": "canonical read"},
             "adjust": {"kind": "compat", "reason": "kept for existing routes; reuse only for a stable domain command"}}}
```

The checker: unknown verb -> fail (needs a reviewed registry entry); `compat` verb on a route not in the
grandfathered list -> fail; grandfathered list may only get shorter.
