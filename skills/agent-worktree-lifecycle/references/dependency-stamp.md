# Dependency stamp (nodeDeps)

> Moved verbatim from `SKILL.md` (slimming 2026-10-21). Entry: [../SKILL.md](../SKILL.md).

### Dependency stamp (`nodeDeps`)

Installed dependencies must match **this** worktree's lockfile, not whatever another
checkout had installed. With `nodeDeps.lockfile` set, a successful install records the
lockfile's hash in a stamp file inside the dependency directory; a missing or different
stamp means stale. The check is off while `nodeDeps.lockfile` is empty.

- `begin` checks after checkout and reinstalls when stale — even without `--install`.
  (`--install` on top can install a second time.) A failed install makes `begin` exit non-zero without a "created" line; the half-made
  worktree stays on disk and the output prints the repair command.
- `end` checks after the final rebase/merge and before the push (only if dependencies
  were ever provisioned there); a failed repair stops finish before anything is pushed.
- `pnpm worktree:deps-sync`, run inside a worktree, repairs on demand and fails closed.
- **A plain `--worker` never installs.** It gets a `WARN` naming the repair command; the
  orchestrator recreates the worktree with `--with-deps` or repairs it. A worker given
  `--with-deps` is checked like any other role.
- An install that rewrites the lockfile, or a missing install command (set
  `nodeDeps.installCommand`, or `postCreateInstallCommand` as its fallback), fails closed.
