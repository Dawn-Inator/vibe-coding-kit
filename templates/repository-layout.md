# Repository root layout

This file describes project-owned root directory boundaries. Adapt it to the
actual project, and update the allowed directories in
`engineering/automation/root-layout/check-root-layout.mjs` in the same change.
The check covers Git-tracked root directories, including staged files; it does
not check untracked or ignored files, and is not automatically a CI gate.

| Directory | Ownership and boundary |
| --- | --- |
| `.vibe-coding/` | Project AI configuration, skills and pinned Kit; not business code. |
| `docs/` | Maintained project documentation; not executable automation. |
| `engineering/` | Maintained development and delivery automation; not product runtime code. |

Add product, infrastructure and other directories only when their ownership is
known. Existing tracked directories outside this initial taxonomy must be
classified before the check passes. Root files are outside this directory check.
