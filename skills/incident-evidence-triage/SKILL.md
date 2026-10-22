---
name: incident-evidence-triage
description: Use when investigating a production or staging incident, missing logs, an alert, a frontend error, a runtime health problem, a request id or trace correlation, or an observability ingestion gap. Routes triage through safe same-environment evidence and requires honest unavailable or no-evidence outcomes.
---

# Incident Evidence Triage

Use this skill before diagnosing or changing logging, alerting, runtime-health checks or incident evidence. If your project keeps a doc describing its logging architecture and where each kind of evidence lives, treat it as the source of truth for the concrete tools; this skill fixes the method and the honesty rules.

## Safety boundary

- Never print or persist tokens, cookies, authorization headers, passwords, one-time codes, phone numbers, email addresses, identity data, request or response bodies, user content, database URLs, access keys, signed URLs, webhook secrets, raw provider responses, message text or stack traces.
- Sanitize before an event leaves a client or a service. Observability is best-effort: a failure of logging, alerting, RUM or the log reader must never fail a business request or transaction.
- Raw logs, errors and runtime metrics do not belong in the business database. Keep them in your log store; any exception for a business fact needs an explicit, written reason.

## Request-id-first workflow

1. Record the incident's stage, time window, symptom, affected route or service, and a safe canonical request id if one exists. Never treat a caller-supplied header as canonical: the backend should accept only ids it minted itself, in a fixed shape, and replace anything else.
2. Start with your project's same-environment log lookup (an admin page or a CLI) keyed by that request id. Never pick another environment, and never use production evidence for dev or staging, or the reverse.
3. Build a time-ordered evidence chain across layers: the application's access/exception record, the reverse proxy's access record, the log store's readback, and the frontend RUM detail for browser-side symptoms. Background workers have no HTTP request id by design; for them use the event name, queue and worker fields, and heartbeat or freshness evidence.
4. If the normal reader is unavailable, use only the documented limited fallback (the active container's stdout or the service journal, plus the proxy's local log). Resolve which runtime is actually active before reading; do not inspect an inactive deployment slot.
5. Separate an application failure from an observability failure. Check the runtime source first, then the collector and its configuration, then the index or query shape. The frontend RUM chain and the backend log chain are independent evidence; one being empty says nothing about the other.

## Evidence outcomes

- Report `verified` only with fresh, same-stage, correlated evidence. Resource names, configuration, a dashboard URL, a secret being set, an old bundle or a passing unit test are not live proof.
- Report `unavailable`, `pending`, `unknown`, or `no matching evidence in <window>` exactly when that is all the source supports. Missing evidence is never rewritten as "healthy", "zero traffic" or "not a product problem".
- Do not infer staging or production readiness from dev. The existence of a collector or RUM control-plane resource is not ingest proof; use the request-id or worker-freshness readback for that very stage.
- When deliberately changing log ingestion, run a strict request-id smoke and keep its correlated evidence. A smoke proves ingestion; it is not the default entry point for an incident.

## Incident report

Return a concise, value-safe timeline with: stage, time window, request or trace correlation, source status, observed symptom, and the exact evidence gap or the next owner. State separately whether the service is unhealthy, the data source is unavailable, or the evidence is insufficient. Link to the relevant console surface instead of pasting log bodies.

## Related skills

- `store-review-monitor` for store-side status, where the same rule applies: an unmapped state is `unknown`, never green.
- `test-gate-router` for choosing verification once the cause is understood.
