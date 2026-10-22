# Q2 region/flavor and Q3 release-channel boundary for CI

Moved verbatim out of SKILL.md to keep the entry small.

### Q2 — Region / flavor (the only remaining build-time dimension, once channel is fixed)

If your app ships more than one storefront/region flavor (different bundle ID suffix, different
default locale, different backend routing), ask which one(s) — and don't assume "build everything" is
supported symmetrically across platforms (see the CLI-flag section above: one platform may allow an
"all regions" flag, a sibling platform may explicitly refuse it and require separate invocations).

### Q3 — Release-channel boundary for CI (if you have one)

If your CI only automates one specific artifact type on your trunk branch (a common pattern: only the
lowest-risk, fastest-to-produce artifact — e.g. an Android debug APK — gets an automatic
trunk-branch pipeline, and every other artifact type requires an explicit, higher-trust release
flow), state that boundary plainly rather than letting someone assume "CI is green" means "the store
submission succeeded." A CI runner reporting success only proves the runner's own steps passed — for
anything that hands off to a third-party review process (app store review, TestFlight processing), the
runner's visibility ends at the hand-off; only the third party's own status page tells you what
actually happened next. Treat "CI green" and "third-party review passed" as two separate, independently
checked facts — never let the first stand in for the second in a completion report.
