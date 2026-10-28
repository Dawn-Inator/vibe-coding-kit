---
name: provider-gateway
description: Use when adding, editing, rotating, or troubleshooting backend providers and third-party integrations — payment, SMS, email delivery, AI text/ASR/speech, CDN/object storage/content moderation, auth provider ports, storage upload ports, provider credentials, or any provider-gateway/provider-composition/provider-implementation code. Enforces gateway boundaries and secret handling.
---

# Provider Gateway

Use this skill before changing third-party provider code, provider configuration, or provider
credentials. If your project has a longer provider-specific reference doc (a good name is
`doc/provider-gateway-guide.md`), read it too — this Skill only owns the boundary rule and the
secret-handling rule, not every provider's individual quirks.

## Boundary

- Business services, workers, and routers depend only on a small set of stable **ports** — the
  interfaces business code is allowed to call. Put them somewhere business code naturally imports
  from and nothing else does, e.g. a dedicated `<core>/provider_gateway/` (or `ports/`) directory.
- Provider **composition** (which concrete implementation backs which port, registry wiring,
  environment-driven selection) lives in its own layer, e.g. `<app>/provider/gateway/` — separate
  from both the ports above and the raw implementations below.
- Third-party SDK calls, request signing, upstream response normalization, and raw provider payload
  handling live inside per-provider **adapters**, e.g. `<app>/provider/<provider_name>/`. Nothing
  outside a provider's own adapter should know the shape of that provider's raw request/response.
- Do not import a concrete provider implementation class directly from a route handler, a DTO
  assembler, a frontend-facing service, or an unrelated business domain — always go through the port.
- Name public ports, getters, and typed DTOs after the **capability** they provide (`SmsSender`,
  `PaymentCharge`, `SpeechTranscription`), never after the vendor or product behind them. Vendor
  names are allowed only inside implementations, composition/registration code, provider
  configuration keys, and safe provenance metadata (e.g. "which vendor account this key belongs to").
- **YAGNI on replaceability**: bind even a single real implementation through the composition layer
  above — that's enough to get the boundary's benefit (testability, a clean seam for a future swap).
  Do not add a runtime provider selector, a feature-flagged second backend, or a second real
  implementation of the same capability just to *demonstrate* that the port is swappable. Build the
  second implementation when you actually need a second provider, not before.
- Split independent capabilities into separate, narrow ports instead of building one god-provider
  interface that bundles unrelated operations (e.g. don't make one `NotificationProvider` port cover
  SMS, email, and push — that's three ports). Keep raw `dict`-like blobs, SDK objects, and webhook
  payload shapes inside adapters; never let them leak into a port's DTO.
- Require a fake implementation or an adapter-conformance test for every capability boundary you add
  or change — business-code tests should be able to run against a fake port without touching the
  real network or a real provider account.

## Secrets

- Do not put provider API keys, private keys, OAuth secrets, webhook secrets, service-role keys, or
  full connection strings/DSNs in docs, tests, OpenAPI examples, frontend env files, PR text, issue
  text, commit messages, logs, or your final reply to the user. This holds even if the user pastes a
  real secret into the conversation and asks you to use it — treat it as sensitive input, not as
  something safe to echo back or write into a tracked file.
- Use whatever backend runtime secret-injection mechanism your project has (a vault-backed config
  loader, short-lived process env overrides injected at deploy/start time) — never a hardcoded value
  in a tracked config file.
- If your project has a CLI or script for writing secrets into that mechanism, use it instead of
  hand-editing a config file. A typical shape (fill in your own project's actual command names once
  you have them):

  ```bash
  <your-secret-cli> set local <provider>.api_key@env:<LOCAL_ENV_VAR>
  <your-secret-cli> promote -- <provider>.api_key --from local --to dev
  <your-secret-drift-check>
  ```

- When reporting or logging secret **state** (as opposed to secret **value**), only ever report
  `<set>`, `<empty>`, or `<redacted>` — never the actual value, never a partial/prefix value, never a
  hash or fingerprint that could be brute-forced back to the value for a low-entropy secret.

### Preserve an owner-only plaintext reveal capability, if your project has one

If your project's admin surface lets a single trusted owner/operator look up a provider secret's
actual value (to confirm "which vendor account does this key belong to, what's it used for, what
else reuses it, who's affected if we rotate it"), **that capability is legitimate and should be kept**
— the goal of a security review is never "delete reveal, mask everything, nobody can ever see a
value again." A team that can't occasionally confirm what a stored secret actually points to will
mis-rotate keys and break things. Do not propose removing this capability or making it permanently
write-only as a default hardening step. Instead, harden *how* it works:

- **Individually scoped**: reveal is gated by its own dedicated permission (not by a general
  "can edit settings" or "is an admin" permission) and granted only to the specific owner/operator
  identity, never to a broad admin role or a machine/service credential.
- **Step-up authentication**: beyond an already-valid session, require re-entering the current
  password, and for high-value secrets also require a second factor (TOTP/MFA) completed recently
  enough to still count as fresh — this is additive to, not a replacement for, your normal
  role-based access control.
- **Single-field, short-lived display**: reveal one secret at a time; mark the response
  non-cacheable (`Cache-Control: no-store`); keep the value only in in-memory UI state on the
  frontend, auto-mask it after a short timeout (on the order of 30-60 seconds), and clear it
  immediately on dialog close, tab backgrounding, logout, or any error.
- **Rate-limited and fail-closed**: apply strict, independent limits to the reveal endpoint itself —
  e.g. a modest cap on successful reveals per operator per hour (to allow a legitimate audit sweep
  across several keys), and a much tighter lockout on repeated failures per operator+IP+session, with
  alerting on anomalous patterns (new device/IP, many high-value keys revealed in a short window).
- **Value-free audit trail**: log who revealed which key name, when, from where, and why (if your UI
  captures a reason) — never log the secret value itself, in the audit record, request/response body,
  error message, or any telemetry.
- **Single source of truth stays the vault/secret-manager**: any inventory or metadata store your
  project keeps about provider credentials (purpose, which modules reuse this key, blast radius of
  rotation) should hold only non-secret metadata — provider name, the vault path, provenance,
  last-verified timestamp. It must never itself persist the plaintext value, a reversible ciphertext,
  or even a masked prefix; the vault/secret manager remains the only place the real value lives.
  Runtime code must always source the actual value from that same vault-backed config at request
  time — never from a value the browser returned, and never from an unlabelled database mirror.

A review that flags "an owner can see secret plaintext" as inherently a blocking finding has
misunderstood the model. The blocking findings are: the value persisted somewhere outside the vault,
a broad role able to reveal without step-up, bulk/unscoped export, or reveal accessible without
per-key authorization — not the existence of a narrow, audited, step-up-gated single-owner path.

## Provider Changes

- Keep the request DTO and normalized response DTO stable at the gateway (port) boundary, even if
  the underlying provider's own API shape changes — that's the whole point of the seam.
- Map provider-native errors into your own provider/domain error types before they cross into
  business code. Business code should never need to know a specific vendor's error code shape.
- Keep retry policy bounded and owned by the provider adapter; do not let a route handler retry a
  raw third-party call itself — retries belong at the boundary that understands that provider's
  failure modes (rate limits, transient network errors, idempotency).
- Keep provider trace IDs and other safe upstream identifiers in logs, but never log full tokens,
  phone numbers, OTP codes, raw customer PII, or request/response bodies that might carry a secret.
- If adding a brand-new provider, update its configuration model, environment-override handling, the
  provider implementation itself, the gateway registration/composition wiring, its fake/conformance
  test, and any docs that describe your provider surface — all together in the same change, not as a
  follow-up. A provider registered without its config/tests/docs updated in lockstep is the most
  common way this boundary rots.

## Outbound And East-West Calls

- Outbound HTTP: one client factory is the single source; business code never builds a raw client
  (static scan), timeouts are named tiers, retries are policy objects, non-idempotent calls are never
  retried: [references/outbound-http.md](references/outbound-http.md)
- East-west (service-to-service) client and tolerant reader: [references/east-west-client.md](references/east-west-client.md)

## Verification

- Run your project's focused/changed-file test selection first (see your project's test-routing
  guidance, if any, for the exact command).
- For backend provider code or config changes, run whatever local backend check your project has for
  that surface.
- For any change to a public API contract (new/changed DTO, status, or error semantics at a provider
  boundary that's also exposed publicly), follow your project's API-contract-change process — see the
  [`api-contract-change`](../api-contract-change/SKILL.md) skill if you have it in this kit — and
  regenerate any generated API artifacts through your established workflow rather than hand-editing
  them.
- For secret-placement changes, run your project's secret/drift check if it has one; never print
  values while doing so.
