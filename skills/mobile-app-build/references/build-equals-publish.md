# Build = publish

Moved verbatim out of SKILL.md to keep the entry small.

## Build = publish (state this plainly; don't make the developer ask for a second step)

For fast-iteration environments (dev, staging), the build command should publish by default — build,
then: upload a versioned artifact → repoint a stable `latest` pointer → refresh a manifest → notify
wherever your team actually looks (chat webhook, etc.). No second command, and don't ask "do you want
me to publish this?" — for these environments, "build" and "ship it to whoever's waiting to test it"
are the same request in practice, so make that the default and let `--no-publish` be the opt-out.

| Scenario | Behavior |
| --- | --- |
| Fast-iteration environment (dev/staging), local build | **publish by default** |
| Production environment (release/store build) | **never** publish through this local path — a store-bound artifact must come from a controlled, auditable release pipeline, not an ad hoc laptop upload |
| Store-bundle format | typically not published this way either — the local fast-publish path only makes sense for a directly-installable package format |
| Running under CI | usually **don't** re-publish here — let CI's own pipeline do its own gated publish step after its own checks, so a local convenience path and an audited CI path never race to publish the same version |
| Developer explicitly wants build-only | flag opt-out (`--no-publish`) |

Whatever credential this step needs, prefer a pre-existing environment credential and fall back to a
just-in-time fetch from your project's own secret-management tool — never hold the credential in a
plain config file. **A publish failure must be a loud, non-zero exit with a retry command, never a
silent skip** — a developer waiting for a test build has no other way to know it never arrived.

### The concrete failure mode that justifies "loud non-zero exit"

If your underlying upload tool has a "copy to a fixed key" step (updating a `latest` pointer, or a
manifest JSON at a well-known path), check whether that tool silently no-ops when the destination key
already exists. Several common object-storage CLIs default to "skip if exists" rather than "overwrite,"
which is exactly backwards for a mutable pointer that is *supposed* to always be overwritten. If you
hit this, the fix is forcing an explicit overwrite flag on every mutable-pointer write — but the
lesson generalizes: any time a step exists purely to update a fixed, well-known location, verify your
tool's default conflict behavior on that exact call, don't assume "it uploaded something" means "it
uploaded to where you meant."
