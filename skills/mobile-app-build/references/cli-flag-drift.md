# Keep the CLI flags honest, not remembered

Moved verbatim out of SKILL.md to keep the entry small.

## Keep the CLI flags honest, not remembered

Whatever your wrapper's flag surface is, treat **the flag-parsing source file as the only truth** for
which flags exist and what they accept — not this document, not memory of an earlier version, not a
teammate's example command from last month. A flag surface that has been simplified over time (e.g. a
multi-value "channel" flag collapsed into a single hardcoded constant) will reject old commands with a
clear "unknown flag" error; that error is the signal to go re-read the parser, not to assume the
tool is broken. Re-verify this section against the actual parser after any change to it — a doc that
quietly drifts from the real flag surface is worse than no doc, because it fails silently instead of
with an exit code.

A concrete, illustrative snapshot of the kind of drift this catches (dates kept for realism, not
because your project needs to match them):

- A `--variant`/multi-channel flag existed, then was removed once the project collapsed down to one
  channel — passing it now exits non-zero with "unknown flag", which is correct, not a regression.
- A generic `--platform` flag exists in the shared parser (because other subcommands, like a dev
  server launcher, consume it) but the *build* subcommand ignores it and hardcodes its own platform —
  passing it to the build subcommand is syntactically legal but semantically a no-op. Don't assume a
  flag that exists in the parser does something for every subcommand that accepts it.
- A "build everything" flag behaves differently between two sibling subcommands (e.g. iOS supports
  "build both regions in one call", Android explicitly refuses it and asks for two separate
  region-scoped invocations) — don't assume flag semantics generalize across sibling commands just
  because the flag name is shared.
- A build-number environment variable becomes mandatory for **every** packaged variant (debug, staged,
  release, app-bundle) partway through a project's life, not just for store-release builds as it may
  have started out. If your project's requirement widens like this, update every example command in
  this doc in the same change — a stale example that omits the now-required variable will fail loudly
  for the next reader, which is at least safe, but wastes their time.
