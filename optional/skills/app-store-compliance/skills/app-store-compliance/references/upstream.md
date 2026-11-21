# External playbook and scanners

The external project is [mjmirza/app-store-compliance](https://github.com/mjmirza/app-store-compliance). The reference inspected for this integration is [commit d2156bab9d7189835631c0a99adcc2479d32138d](https://github.com/mjmirza/app-store-compliance/tree/d2156bab9d7189835631c0a99adcc2479d32138d), release 2.4.0. This records provenance; it does not certify that its policy claims remain current.

## Distribution boundary

This Kit component contains original guidance and links. It does not redistribute the external project's skill, documentation, rule data, or scripts, and it does not provide the upstream `/app-store-audit` command or automatic submission guard.

The external version identifies its license as [LicenseRef-OpenRoots-ORA-2.3](https://github.com/mjmirza/app-store-compliance/blob/d2156bab9d7189835631c0a99adcc2479d32138d/LICENSE), with [canonical terms](https://openroots.org/licenses/ora/2.3/legalcode.txt). It has commercial conditions and restrictions beyond MIT. Kit's MIT license covers this original component; it does not relicense the external project or establish permission for a particular organization's use. Resolve applicable terms before separately acquiring, using, modifying, or redistributing that project. An unavailable checkout or unresolved license does not block the original evidence-based review workflow.

## Reference map

Browse only the external resources needed for the current review, subject to applicable terms:

- [Rejection patterns](https://github.com/mjmirza/app-store-compliance/blob/d2156bab9d7189835631c0a99adcc2479d32138d/data/rejection-patterns.json): candidate pattern IDs and investigation leads.
- [Pre-submission checklist](https://github.com/mjmirza/app-store-compliance/blob/d2156bab9d7189835631c0a99adcc2479d32138d/docs/PRE-SUBMISSION-CHECKLIST.md): console and operational checks.
- [Apple guide](https://github.com/mjmirza/app-store-compliance/blob/d2156bab9d7189835631c0a99adcc2479d32138d/docs/APPLE.md) and [Google Play guide](https://github.com/mjmirza/app-store-compliance/blob/d2156bab9d7189835631c0a99adcc2479d32138d/docs/GOOGLE-PLAY.md): platform-specific leads.
- [Rejection and appeal cases](https://github.com/mjmirza/app-store-compliance/blob/d2156bab9d7189835631c0a99adcc2479d32138d/docs/MISTAKE-PATTERNS.md): examples for investigating an actual reviewer message.
- [Framework coverage](https://github.com/mjmirza/app-store-compliance/blob/d2156bab9d7189835631c0a99adcc2479d32138d/docs/CROSS-PLATFORM-FRAMEWORKS.md): limitations for generated or absent native projects.

Do not treat dated regulatory files, heuristic findings, or example fixes as authoritative policy. Use current official sources to decide applicability.

## Run scanners from a separate checkout

Use these commands only when the user wants the external scan and has an authorized checkout. The component does not download it. Resolve the actual absolute paths; the variables below are examples for a Bash session:

```bash
compliance_checkout='/absolute/path/to/app-store-compliance'
app_root='/absolute/path/to/mobile-app'
metadata_root='/absolute/path/to/store-metadata'

git -C "$compliance_checkout" rev-parse HEAD
git -C "$compliance_checkout" status --short
bash "$compliance_checkout/agent-os/hooks/app-store-compliance-guard.sh" "$app_root"
```

Inspect local changes and compare the checkout with the reference revision before using its scripts. Record a different revision and re-inspect its behavior instead of resetting a user's checkout. Keep the full repository layout: the guard resolves validators under `scripts/` and deadline data under `data/` relative to its own location.

Requirements for this external path are Bash and standard Unix utilities; Python 3 supports the manifest validator, deadline listing, and metadata scanner. On Windows this needs a compatible Bash environment such as Git Bash; the Kit guidance itself is platform-independent. Missing tools reduce scan coverage and must be reported.

At the reference revision the guard also sources `~/.claude/hooks/hook-log.sh` when present. Inspect that file and its effects before executing the guard; do not describe the external command as guaranteed read-only. The normal standalone scan uses temporary files. Preserve its findings and coverage even when it exits nonzero; do not set `APP_STORE_GUARD_OK` to make findings disappear.

To inspect existing local store metadata, choose the matching platform:

```bash
python3 "$compliance_checkout/scripts/metadata-audit.py" "$metadata_root" --platform apple
# For Google Play metadata, use --platform google instead.
```

The default metadata scan reads local files. `--propose` writes a suggestions file and `--check-urls` sends network requests; use them only within the requested scope. Pulling live metadata is a separate authenticated operation. Do not run `scripts/install.sh` as part of this skill: it modifies global tool settings and hook registrations.

Avoid `scripts/release-audit.py` as a shortcut for a read-only audit: at this revision it runs the upstream test engines and writes a report into the target project. Follow the project's explicit test and write authorization if that separate workflow is requested. Monitors and fleet operations are also outside the default review scope.

## Interpret results

The guard's exit 2 indicates detected critical risks. Exit 0 or `CLEAR` does not establish store approval or resolve high/medium findings. `NOT CHECKED`, incomplete coverage, missing validators, interruption, or scanner errors remain unresolved even if another part prints a successful status. The metadata scanner can report that nothing was audited; keep that absence visible.

Convert scanner clues into confirmed issues only after checking actual app evidence and the current official rule. Record unsupported heuristics or false positives with their reason rather than changing the app to satisfy a keyword scan.
