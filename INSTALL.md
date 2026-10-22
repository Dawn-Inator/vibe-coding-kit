# Installation

Vibe Coding Kit is consumed as a pinned Git submodule. It is not currently published as an npm package and does not install a global command. Invoke `cli.mjs` with Node from the checked-out repository, passing the consuming project root explicitly.

## Add the kit to a project

From the root of an existing Git project:

```sh
git submodule add --name vibe-coding-kit https://github.com/Dawn-Inator/vibe-coding-kit.git .vibe-coding/kit
node .vibe-coding/kit/cli.mjs init --project-root . --check \
  --identity-name "Project Contributor" \
  --identity-email "contributor@example.com" \
  --skill agent-worktree-lifecycle=adopt \
  --skill coding-gate-preflight=adopt
```

Review the planned files and any reported conflicts. The check exits nonzero when initialization would create files or finds a conflict. Pass the same identity and skill options to the dry run and the actual initialization. For a new setup, provide the project's own commit identity and choose the public skills it wants to adopt or extend:

```sh
node .vibe-coding/kit/cli.mjs init --project-root . \
  --identity-name "Project Contributor" \
  --identity-email "contributor@example.com" \
  --skill agent-worktree-lifecycle=adopt \
  --skill coding-gate-preflight=adopt
```

`--skill` may be repeated. Supported decisions are `adopt`, `extend`, `replace:<reason>`, and `exclude:<reason>` for public skills; `local` is for a project-only skill. When any public skill is selected, public skills omitted from the command are initially recorded as excluded. `extend` creates a project-owned `EXTENSION.md` starter; `replace` requires an existing local `SKILL.md` and a reason. Edit `.vibe-coding/project.config.json` to adjust these decisions after setup.

`init` requires a registered `vibe-coding-kit` submodule whose path and URL match the project config. It creates `.vibe-coding/project.config.json`, `.vibe-coding/loading.md`, the project-owned bootstrap and adapter, and any requested extension starters. If the project already has a `package.json`, it merges the kit scripts listed below; conflicting script names are reported and left unchanged. It does not create a business `package.json`, install application dependencies, deploy, create cloud resources, or commit changes. Existing files with different contents are reported as conflicts and are left untouched. Review and commit generated files and the submodule gitlink as part of the project.

### Existing projects and integrations

Run `init --check` first on an existing project. Resolve each reported conflict deliberately; the initializer does not overwrite existing project configuration, adapters, loading sources, or scripts. In a mature integration, keep the thin project-owned bootstrap and adapter as the bridge to the shared runtime. The LingoFly integration is an example of that bridge pattern: its project-specific policy stays in its own repository, and the public kit does not supply or authorize its production or gate rules. Do not use first-time scaffolding to replace an established bridge.

## Check and prepare the pinned version

The project gitlink is the version authority. `check` reads the project state; `prepare` explicitly checks out the gitlink-pinned version:

```sh
node .vibe-coding/kit/cli.mjs check --project-root .
node .vibe-coding/kit/cli.mjs prepare --project-root .
```

Use `prepare --offline` when the required Git object must already be available locally. Preparation does not select a newer version. To upgrade, review and change the gitlink in a deliberate project change, then prepare and validate that pinned commit.

The top-level CLI also supports `inspect`, `skills <sync|check>`, and `worktree <command>`. Skill operations compose the selected public skills with project-local skill sources, then write or validate generated mirrors. Worktree commands are forwarded to the worktree runtime; `worktree help` lists its current command names and flags.

When a `package.json` exists, `init` merges these scripts unless a different command already owns the name:

| Script | Generated command |
| --- | --- |
| `skills:sync` | Bootstrap, prepare the pinned kit, then sync skill projections |
| `skills:check` | Bootstrap, prepare the pinned kit, then check skill projections |
| `worktree:begin` | Bootstrap, prepare the pinned kit, then run worktree `begin` |
| `worktree:end` | Bootstrap, prepare the pinned kit, then run worktree `finish` |

Without a `package.json`, invoke the bootstrap or top-level CLI directly with Node; the installer does not add a placeholder package manifest.

### Current implementation boundaries

The CLI does not add the submodule; add it with the registered name and path shown above. `init` currently generates the default `.vibe-coding/` and `engineering/automation/vibe-coding/` layout and the four script names in the table. It does not discover or migrate an existing bridge, choose alternate adapter/bootstrap paths, or resolve file and script conflicts automatically. Existing integrations must keep and adapt their project-owned wiring. Do not treat `inspect` output or undocumented flags as a stable interface; check the current CLI help and project integration before depending on them.

The generated project bootstrap is the small project-owned entry point used before importing the submodule runtime. It can prepare or check the registered submodule without installing a global tool:

```sh
node engineering/automation/vibe-coding/bootstrap.mjs prepare
node engineering/automation/vibe-coding/bootstrap.mjs check
```

Projects should route their own scripts and automation through that bootstrap before importing kit runtime modules. The bootstrap is generated once from a template and remains project-owned; the reusable runtime remains in `.vibe-coding/kit/src/` and is invoked there directly. `prepare` hydrates the exact gitlink version; it does not run `init` or recopy template files.

For an initialized consumer project, a recursive clone retrieves the pinned kit with the parent project. After a normal clone that left the submodule empty, run the generated bootstrap's `prepare` command from inside the project before invoking a kit-backed script.

The documented command surface reflects the implementation currently in this repository. Alternate-layout discovery and automatic migration of existing integrations are not implemented, and cross-platform Git/worktree compatibility remains unverified. Do not infer those guarantees from the default path examples.

## Project sources and generated files

The consumer owns `.vibe-coding/project.config.json`, `.vibe-coding/loading.md`, local `.vibe-coding/skills/` extensions, and its memory, history, and documentation. These are project sources. The kit combines selected public skills with local skills/extensions, then generates skill mirrors and root instruction files such as `AGENTS.md` or `CLAUDE.md`, according to the project's tooling and tracking policy. Edit their source and regenerate the projections; do not treat generated output as the authority.

The kit's `templates/` directory is only for initial scaffolding. Routine `prepare`, skill synchronization, and kit upgrades do not copy templates over project files. A project may evolve its generated configuration and adapter after initialization.

## Compatibility and project policy

The kit requires Node.js 20 or newer and Git. The consuming project decides which capabilities to enable and supplies its own identity, adapter, environment rules, gate commands, and release authorization. The tutorial's branch and production examples explain design choices; they do not configure or authorize a consumer's deployment workflow.

For current command syntax, run:

```sh
node .vibe-coding/kit/cli.mjs help
```
