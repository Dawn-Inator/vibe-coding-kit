# Real-device sign-in, env injection guard, common errors, build-number discipline

Moved verbatim out of SKILL.md to keep the entry small.

## Real-device verification without hand-typed credentials

When a build is installed on a real device for acceptance testing and needs to be signed in, prefer a
controlled test-account session-import mechanism over hand-typing an email/password on the device, and
never pause to ask a human stakeholder to personally log in just to unblock a test build — check
whether your project already has a scripted device-session import path before escalating. Constrain
that mechanism to non-production environments only, require an explicit online-device check (never a
simulator/emulator), and never print or persist the underlying credential — exchange it for a
one-time, narrowly-scoped session token at the point of use.

## Environment injection guard (don't route around it)

Whatever your build wrapper's guard looks like, it should reject at minimum:

- an empty API base URL;
- `localhost` / `0.0.0.0` / a loopback IP / `[::1]` — a device's loopback is never your laptop's;
- a non-`http(s)` scheme.

This must run **before** the native compile step, not as a post-hoc lint — the point is to fail fast
with a clear message, not to ship a brick and diagnose it after a tester reports "nothing loads."

## Common-error quick reference (adapt to your own wrapper's messages)

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Native build refuses with "local API URL" | built against the `local` environment | switch to a real remote-reachable environment |
| "Unknown flag" for something that used to work | the flag surface changed; you're working from stale memory/docs | re-read the actual flag-parsing source, not this doc |
| "Build number required" | the mandatory build-number variable is unset | set it to an unused, monotonically-safe value (see below) |
| Artifact isn't where you expected | you (or a script) drove the native toolchain manually, bypassing the wrapper | always go through the wrapper; never hand-claim the native toolchain's own default output directory as the "real" artifact |
| Signing/export failure on the iOS side | local toolchain isn't pointed at a full IDE install, or a signing profile/credential is missing | verify the toolchain path and license acceptance first, before touching signing config |

### Build-number / version-code discipline

If your platform ties a monotonically-increasing build number to "can this be installed over the
existing app on this device" (Android's `versionCode` is the canonical example — a lower number is a
hard install-time rejection, not a warning), treat the build-number input as unsafe to reuse blindly:
check what's already installed on the target device before picking a number for a build that will be
side-loaded over it.
