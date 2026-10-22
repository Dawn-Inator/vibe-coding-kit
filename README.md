# Vibe Coding Kit

Vibe Coding Kit is a versioned set of reusable AI-assisted engineering tools, project templates, skills, and tutorials. It is designed to be consumed by projects with their own architecture, workflow, and release policies.

## Repository and consumer path

This repository is the public source of the kit. A consuming project checks it out as a Git submodule at `.vibe-coding/kit/`; that path is a consumer convention and is not an extra directory inside this repository. The parent project's gitlink pins the exact kit commit used by that checkout.

The runtime under `src/` is called directly from the pinned checkout. Consumers must not copy the runtime into their own source tree. Files under `templates/` are initial project scaffolding: `init` may create project-owned configuration, loading instructions, and adapter/bootstrap files once, and later prepare or upgrade operations must not replace those files. A project owns its configuration, adapter, skills extensions, and knowledge sources after initialization.

## Contents

- [`skills/`](skills/) contains 27 current reusable skills. Projects select and extend them according to their own needs.
- [`tutorial/`](tutorial/) explains the methods and tradeoffs behind the skills. Tutorial examples are illustrative, not mandatory project policy.
- [`src/`](src/) contains reusable runtime mechanisms.
- [`schemas/`](schemas/) defines public configuration and adapter contracts.
- [`templates/`](templates/) contains files intended for one-time project initialization.
- [`cli.mjs`](cli.mjs) provides the direct Node entry point for initialization, dependency checks/preparation, skill projection, and worktree commands.

Project source files remain the authority. Generated skill mirrors and generated root instruction files are projections; update their declared source and regenerate them using the project's tooling.

The kit is invoked from its Git checkout with Node. It is not currently distributed as an npm package or global command. See [INSTALL.md](INSTALL.md) for initial setup and the command surface.

## Policy boundary

The kit provides reusable mechanisms and examples. Each consuming project defines its own branches, environments, gate commands, authorization rules, deployment policy, and business constraints through project-owned configuration and adapters. No single project's production or gate policy becomes a default for every consumer. Existing integrations, including the LingoFly bridge, may keep thin project-owned bootstrap and adapter wrappers; the wrapper supplies project policy and delegates reusable operations to the pinned kit.

## Installation

See [INSTALL.md](INSTALL.md) for the submodule layout, the direct Node CLI, and the distinction between initialization and routine preparation.

## License

The MIT license in [LICENSE](LICENSE) applies to original material authored for this repository by Dawn-Inator. It does not replace or broaden any third-party license. Any third-party component or material must retain its own notices and terms.
