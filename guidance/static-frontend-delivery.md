# Static frontend delivery

This guide defines provider-neutral contracts for publishing static frontend builds through object storage and a CDN. It is a project adoption standard, not a publisher, cloud SDK, deployment workflow, or proof that a live system follows its declarations. Record concrete providers, regions, account roles, bucket names, domains, DNS values, and approval state in the project adapter and its operational documentation.

## Classify every delivery surface

For each delivered surface, declare its project, environment, surface, source revision, purpose, physical store/namespace identity, artifact class, key layout, access, cache policy, retention, and rollback window. Keep web, admin, mobile web, and downloadable archives distinct when their audiences or lifecycles differ. Keep dev, staging, and production distinct. Avoid deriving environment from a hostname or a developer's local context. The physical store identity is needed to detect key-prefix collisions even when logical project or environment labels differ.

Use separate artifact classes:

| Class | Key behavior | Access and cache |
| --- | --- | --- |
| Public immutable assets | Include the full source revision as a path segment; never overwrite that key with different bytes. | Public; `public, max-age=31536000, immutable` or a longer lifetime. |
| Public documents | Entry HTML or other public documents; use a stable or versioned origin path as required by the runtime. | Public and revalidated (`no-store`, `no-cache`, or `max-age=0, must-revalidate`); do not give documents a year-long immutable cache. |
| Private templates | Include the full source revision as a path segment; these can be backend templates consumed to produce a public shell. | Private; `no-store`. |
| Private archives | Bind the archive filename exactly to its full revision, such as `<sha>.tar.gz` or `<sha>.tar.gz.sha256`, and keep it outside public web serving. | Private; `no-store`. |
| Mutable live pointer | Keep a stable key, separate from revisioned artifact prefixes. | Private and `no-store`; restrict writes to the publishing identity and reads to intended runtimes. Do not apply automatic expiration to the active pointer. |

A version is an opaque full commit SHA (40 or 64 lowercase hexadecimal characters in the kit validator), carried as one complete path segment for immutable artifacts. For archives, the filename must be exactly that SHA followed by `.tar.gz` or `.tar.gz.sha256`; do not accept a SHA that is merely a substring of a differently named archive. Build key paths from validated literal segments. Reject empty, dot, dot-dot, separator-containing, percent-encoded, or otherwise unsafe segments; do not concatenate untrusted URL paths. Keep artifact prefixes disjoint within the same physical store, even if logical project/environment/surface labels differ, so one artifact class cannot shadow another through prefix behavior.

## Publish and retire safely

Treat publication as a serialized state transition. The project must choose and document one of two consistency strategies:

1. **Fenced lease**: acquire conditionally; every externally visible mutation (including host flip, pointer update, and garbage collection) carries a fencing generation that the receiver checks and rejects when stale. A lease expiry or takeover is safe only if the old owner cannot complete a delayed side effect after losing ownership.
2. **Durable exclusive mutex**: acquire by create-only write; do not apply automatic expiration or takeover. Permit reentry only after proving ownership. Hold the same lock across host flip, pointer update, and garbage collection. Release it exactly once after every owned I/O has settled; on timeout, disconnect, or unknown mutation outcome, retain it. Recover a stuck lock only after explicit proof of quiescence, then perform one controlled release. A stuck lock must leave the already-serving site available even though further publication is blocked.

The durable mutex control record uses a project-configured private key and physical store. Keep it outside public/CDN serving and exclude it from age-based garbage collection and automatic expiry. Use provider capabilities only when they enforce the selected contract; a local process mutex or an expiring lock without stale-owner fencing does not serialize distributed publishers safely.

After immutable objects are uploaded and verified, read the live pointer back through the runtime-facing path and verify it selects the intended revision. Garbage collection shares the selected exclusion strategy so it cannot remove an object being published or selected. The kit validator checks that the strategy is declared; it cannot prove live lock semantics, provider fencing, or successful runtime readback.

Model release state explicitly:

- `current`: selected by the stable pointer and readable by the runtime.
- `previous`: retained and readable for rollback, with a declared count.
- `retained`: immutable artifacts remain available for the declared minimum period and while referenced by any retained shell, archive, or pointer. Current, previous, and other referenced releases must not be removed by age-only collection; the active pointer itself has no automatic expiry.
- `grace`: the rollback window remains open for a declared duration before eligible objects can be collected.

The retention period must cover the grace window. Garbage collection should remove only unreferenced objects beyond the retention and rollback policy. Keep pointer history sufficient to reconstruct current and previous selection; do not make a pointer update appear successful merely because an upload succeeded. A positive minimum retention period does not override current/previous/reference protection; a stable pointer declares indefinite retention rather than a TTL.

Treat provider or domain retirement as a dependency-graph change. Before retiring storage, CDN distribution, hostname, registrar registration, or billing account, identify which projects, environments, shells, archives, certificates, DNS records, redirects, and rollback windows depend on it. Move traffic and retained artifacts, prove the replacement is observed at the runtime boundary, then retire old dependencies according to the project's authorized process. Registrar ownership, transfer locks, renewal, billing, and DNS delegation have separate lifecycles and must not be inferred from CDN or storage state.

## Keep evidence states separate

Report each property as one of:

- **Declared**: present in project configuration or IaC.
- **Observed**: verified from provider/runtime behavior, with timestamp, target environment, and exact revision where applicable.
- **Accepted**: reviewed against the project's acceptance criteria by an authorized owner.

Do not convert a declaration into an observed fact or use a green configuration check as runtime proof. Missing IaC resources, mismatched provider state, stale pointers, and untested rollback remain explicit gaps. Record evidence per environment and delivery surface; one environment's readback does not prove another.

## Kit validation contract

`validateStaticFrontendDelivery` in `src/contracts/static-frontend-delivery.mjs` is a pure, provider-neutral structural/policy check. It validates declared dimensions, revision and path safety, physical-store prefix separation, class-specific access/cache rules, retention and rollback fields, and publication concurrency declarations. It performs no I/O and returns structured `{ path, code, message }` errors. Its result has only `ok` and `errors`; it does not create declared/observed/accepted evidence, publish artifacts, or attest provider concurrency. Project-specific schemas may wrap it, but must preserve those evidence boundaries.
