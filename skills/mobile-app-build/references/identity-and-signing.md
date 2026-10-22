# Distribution identity: bundle IDs and signing keys

Moved verbatim out of SKILL.md to keep the entry small.

## Distribution identity: bundle IDs and signing keys

Track, in one place, the concrete identity each shipped variant carries — this is the kind of
"contract" detail that silently rots when it only lives in scattered build-config files:

| Region/lane | Release bundle ID | Non-release suffix |
| --- | --- | --- |
| `global` | `com.nova.app` | `.preview` / `.dev` |
| `cn` | `com.nova.app.cn` | `.preview` / `.dev` |

Signing keys, by lifecycle:

| Keystore | Tracked in git? | Scope |
| --- | --- | --- |
| shared debug keystore | **yes** — team-shared, hardcoded well-known password (no secrecy value; the point is everyone's debug builds share one signer so debug APKs can be installed over each other without an uninstall) | every debug build, every region |
| per-region release keystore(s) | **no** — local + CI secrets only | that region's release/store build only |

Collect each release keystore's signing fingerprint (SHA-1/SHA-256) in one place outside git (a local
notes file, a secrets manager entry) — third-party SDK consoles (push notification providers, OAuth
providers, crash reporting, maps) commonly ask you to register a fingerprint per signing key, and
having it collected once beats re-deriving it from the keystore every time a new SDK needs it.

**Where "outside git" concretely lives**: use the same dot-prefixed, gitignored-directory naming
pattern your project's [repository-layout](../../repository-layout/SKILL.md) skill already establishes
for other local/CI-only material — e.g. a `.ci-secrets/` directory sitting next to the native project
it documents (`apps/<mobile-app>/android/.ci-secrets/`, or wherever your native source lives), holding
one plain file per concern (a `release-info.md` with fingerprints, provisioning-profile identifiers,
whatever a third-party console will ask for). The dot prefix and the directory's own name are doing
real work here, not just hiding the folder: anyone who lands in the native project directory should be
able to tell from the name alone that this holds sensitive, environment-specific, CI-adjacent
reference material — not source, not a build artifact, not something to copy into a new environment
without regenerating it there. Gitignore the directory itself, not just its contents, so a new file
dropped in later doesn't need a second gitignore entry to also stay untracked.
