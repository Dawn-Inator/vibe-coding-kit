# Naming convention and channel/environment mapping

Moved verbatim out of SKILL.md to keep the entry small.

## Naming convention: this is the concrete part worth copying as-is

This is the single most copy-worthy piece of this skill — the artifact directory layout, filename
template, and remote object-storage key shape. Keep the *principle*, not necessarily every literal
segment: **artifact directory names, channel names, and environment names are three independent
vocabularies that happen to be related by an explicit mapping table — never assume any two of them
are spelled the same, and always document the mapping table itself, not just its existence.**

### Local/CI release directory

```
release/mobile/<stage>/<git-sha>/
├── android/
│   ├── nova-cn-android-official-debug.apk
│   ├── nova-cn-android-official-release.aab
│   └── ...
├── ios/
│   └── nova-cn-ios.ipa
└── evidence/
```

| Artifact | Template |
| --- | --- |
| Android APK | `{app}-{region}-android-{channel}-{debug\|release}.apk` |
| Android AAB | `{app}-{region}-android-{channel}-release.aab` (a store bundle is always a release build) |
| iOS Archive | `{app}-{region}-ios.xcarchive/` |
| iOS IPA | `{app}-{region}-ios.ipa` |

`region` is a real build-time flavor dimension (different bundle ID suffix, different default
locale). `channel` here is **frozen to one literal value** (e.g. `official`) — it used to be a real
multi-value dimension (this project once shipped separate OEM-store variants), and the literal string
is kept in the filename template purely for naming continuity, not because more values are selectable.
If your project genuinely has multiple live channels, this is exactly the pattern the next section
generalizes.

### Remote object-storage key: channel name ≠ environment name (the actual trigger for this skill)

```
android/{region}/official/{channel}/{versionMajor}/{versionDir}/{versionName}-{shortSha}-run-{runId}-attempt-{attempt}.apk
android/{region}/official/{channel}/latest.apk                      ← mutable pointer, always overwritten
android/{region}/official/{channel}/release-manifest.json           ← mutable pointer, always overwritten
```

with a small, explicit, centrally-defined mapping table — **this table is the actual contract, and it
is the one thing worth copying verbatim as a pattern**:

```js
const CHANNEL_BY_STAGE = Object.freeze({ dev: 'debug', stg: 'preview' });
// prod deliberately has no entry here — production artifacts never go through this path (see "Build = publish" above)
```

The reason this needs its own callout: **a directory named after the artifact's build type/channel
is not the same string as the environment name that produced it**, and someone skimming the bucket
expecting `android/{region}/official/dev/...` (matching the `ENV=dev` they just ran) will not find
their upload — it landed under `debug`, because `debug` is the *channel* the dev environment happens
to map to, not the environment's own name. Two independent, related-but-different tiers of
environments and channels can even legitimately **share one bucket**, distinguished purely by this
directory segment — that's a valid, deliberate design (simpler bucket/IAM topology), not a
misconfiguration, as long as the mapping table above is the single place that says so.

Whatever your own project's actual environment→channel mapping is, write it down explicitly, next to
your build wrapper, exactly like the table above — the entire value of this section is that no one
should ever have to reverse-engineer it from an upload script's source code, the way this exact
mapping was discovered in this project.
