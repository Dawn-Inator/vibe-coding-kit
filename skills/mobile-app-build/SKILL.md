---
name: mobile-app-build
description: "Use when packaging a Capacitor + Next.js static-export mobile client into an Android APK/AAB or iOS IPA — region flavor (e.g. cn/global), a single fixed distribution channel. Triggers: 'build apk', 'package mobile', 'build ipa', 'ship a debug build'. Skip for backend-only or web-only changes."
---

# Mobile App Build (example wrapper commands: `pnpm build:android` / `pnpm build:ios`)

This skill documents a **worked, complete example** of a native mobile build/publish pipeline for a
Capacitor + Next.js static-export app (region flavors, one fixed distribution channel, native build
number requirements, an immutable-artifact OSS/CDN publish flow). Adapt the concrete command names,
paths, and identifiers to your own project; keep the *shape* of the contract — a single wrapper
command, a hard-required build number, a channel name that is independent of the environment name,
and version-immutable published artifacts.

> **`build:android` / `build:ios` are example commands, not part of this kit.** The kit's
> `package-scripts-snippet.json` does not define them — wire up your own wrapper scripts under
> whatever names fit your project, and substitute those names wherever this skill says `build:android`
> / `build:ios`.

## When to use

Packaging the mobile client for Android/iOS, publishing a dev/staging build, or installing a build on a
real device for acceptance. Skip for backend-only or web-only changes.

## Red lines

### Golden rule: use the wrapper command, never call the native toolchain directly

A single script wraps the full chain — build the static web export → sync it into the native project →
run the platform build tool (Gradle / Fastlane) → verify the output → publish it to a stage-scoped,
git-SHA-scoped release directory. Any manual `cd android && ./gradlew assembleXxx`, manual
`next build`, or manual `cap sync` bypasses:

- **the env-injection guard** (rejects `localhost` / `127.x` / `0.0.0.0` from ever reaching a
  compiled artifact — a device can't reach your laptop's loopback address, so a "successfully
  built" APK that silently can't talk to any backend is a worse failure than a build error);
- **stage selection** (which `env/<stage>.json` gets baked into the native bundle);
- **keystore preparation**;
- **artifact placement** — the wrapper puts finished output at a stable, predictable path; a manual
  build leaves it wherever the native toolchain's own default output directory happens to be, with a
  non-conforming filename.

Manually driving the native toolchain produces artifacts in the wrong place with the wrong name —
that is the recurring failure mode this rule exists to prevent, not a style preference.

### Flags: the parser is the only truth

Treat **the flag-parsing source file as the only truth** for which flags exist and what they accept —
not this document, not memory of an earlier version, not a teammate's example command. An "unknown
flag" error is the signal to go re-read the parser, not to assume the tool is broken. Don't assume a
flag that exists in the parser does something for every subcommand, or that a flag like "build
everything" behaves the same across sibling commands (iOS may allow it, Android may refuse it).
Re-verify docs against the parser after any change to it. Drift examples:
[references/cli-flag-drift.md](references/cli-flag-drift.md).

### Ask two questions before building — never infer them

Any "build a package" request must confirm **environment** and **region/flavor** explicitly (via
whatever interactive question mechanism your agent has) before running anything. Do not default to
whatever `.env` already has, and do not guess from context. Environment and build type are
**strongly bound** — the developer picks environment, build type follows; never ask "debug or
release" separately:

| Choice | ENV | Build type | Flag | Purpose |
| --- | --- | --- | --- | --- |
| Test environment (recommended default) | `dev` | `debug` | (none) | self-test / hand to a teammate / connect to the shared dev backend |
| Production (installable package) | `prod` | `release` | `--release` | sideload / internal release |
| Production (store bundle) | `prod` | `release` | `--aab` | app-store upload (stores that require a bundle format enforce this) |

Refuse outright, no matter how the developer phrases the request:

- Building against a `local` environment at all.
- `dev` environment + a release/store build type (ships an unminified debug build against an
  internal-only domain).
- `prod` environment without the release/bundle flag (ships an unminified debug build to production).
- Forgetting the mandatory build-number variable — the wrapper must refuse loudly rather than silently
  reuse an old number a device may already have installed. Before side-loading over an existing app,
  check what build number is installed on the device (Android `versionCode`: lower = hard rejection).

Region/flavor and the CI release-channel boundary: [references/region-and-ci-boundary.md](references/region-and-ci-boundary.md).

### Publish and secrets

- **Production never publishes through the local fast-publish path.** A store-bound artifact must come
  from a controlled, auditable release pipeline, not an ad hoc laptop upload. Store-bundle formats are
  typically not published this way either; under CI, don't re-publish locally.
- Dev/staging builds publish by default (build = publish; `--no-publish` is the opt-out). **A publish
  failure must be a loud non-zero exit with a retry command, never a silent skip.** For any step that
  only updates a fixed well-known key (a `latest` pointer, a manifest), verify the upload tool's
  overwrite behavior on that exact call. Details: [references/build-equals-publish.md](references/build-equals-publish.md).
- Credentials: prefer a pre-existing environment credential, fall back to a just-in-time fetch from
  your secret-management tool; **never hold a credential in a plain config file**, and don't hardcode
  a secret into a tracked config file to "save a step". Release keystores stay out of git; the shared
  debug keystore may be tracked. See [references/identity-and-signing.md](references/identity-and-signing.md).
- Never report a store submission as "done" from CI-green alone — confirm against the store's own
  processing status if that hand-off exists in your pipeline.

### Environment injection guard (don't route around it)

The wrapper must reject, **before** the native compile step: an empty API base URL; `localhost` /
`0.0.0.0` / a loopback IP / `[::1]`; a non-`http(s)` scheme.

### Real-device sign-in

Use a controlled test-account session-import mechanism, not hand-typed email/password on the device,
and never pause to ask a human stakeholder to log in just to unblock a test build. Non-production
only, require an online real device (never a simulator/emulator), never print or persist the
credential. See [references/device-session-guards-and-errors.md](references/device-session-guards-and-errors.md).

## Don't-do list

- Don't invoke the native toolchain (Gradle, Fastlane, etc.) directly — always go through the wrapper.
- Don't default silently to whatever `.env`/config file already has for environment or region — always
  confirm explicitly.
- Don't build against a `local`/loopback-backed environment expecting it to work on a device.
- Don't hand-claim a native toolchain's own default/intermediate output directory as the real,
  publishable artifact.
- Don't hardcode a secret value into a tracked config file to "save a step" — use your project's
  secret-management entry point even when printing/reading the value back is otherwise allowed.
- Don't report a store submission as "done" from CI-green alone — confirm against the store's own
  processing status if that hand-off exists in your pipeline.
- Don't skip the build-number/version-code precondition even for a "quick internal test build."

## When you hit X, read Y

| When | Read |
| --- | --- |
| A flag is rejected or its semantics differ across sibling commands | [references/cli-flag-drift.md](references/cli-flag-drift.md) |
| Multiple region flavors, or CI only automates one artifact type | [references/region-and-ci-boundary.md](references/region-and-ci-boundary.md) |
| Designing publish defaults, credentials, or the "skip if exists" upload trap | [references/build-equals-publish.md](references/build-equals-publish.md) |
| Artifact directory layout, filename template, channel ≠ environment mapping | [references/naming-and-channel-mapping.md](references/naming-and-channel-mapping.md) |
| Bundle IDs, keystores, signing fingerprints, `.ci-secrets/` | [references/identity-and-signing.md](references/identity-and-signing.md) |
| Real-device sign-in, injection guard, common errors, build-number discipline | [references/device-session-guards-and-errors.md](references/device-session-guards-and-errors.md) |
