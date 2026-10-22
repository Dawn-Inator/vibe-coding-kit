# Command reference

The public runtime is in `.vibe-coding/kit/src/worktrees/`. Invoke supported worktree
commands from the consuming project's root through the pinned kit CLI:

```sh
node .vibe-coding/kit/cli.mjs worktree help
```

The CLI currently routes `status`, `create` / `begin`, `finish` / `end`, `sync-primary`,
`cleanup`, `deps-sync`, `client-check`, `stash-audit`, `stash-guard`, `primary-lock`, and
`primary-audit`. For example:

```sh
node .vibe-coding/kit/cli.mjs worktree begin --name "<task>"
node .vibe-coding/kit/cli.mjs worktree status
node .vibe-coding/kit/cli.mjs worktree finish --message "type(scope): summary"
```

Initialization adds `worktree:begin`, `worktree:end`, `worktree:status`, `worktree:cleanup`,
and `worktree:sync-primary` aliases when the project has a `package.json`. It does not create
aliases for the other commands. Add project-owned package scripts or automation adapters
if those are part of the project's workflow. Runtime command support does not establish a
project's branch, deployment, authorization, or cleanup policy.
