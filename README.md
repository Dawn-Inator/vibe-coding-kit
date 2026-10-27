# Vibe Coding Kit

Vibe Coding Kit is a versioned set of reusable AI-assisted engineering tools, project templates, skills, and tutorials. It is designed to be consumed by projects with their own architecture, workflow, and release policies.

## 中文快速开始

在一个已提交且工作区干净的 Git 项目根目录，用 Node.js 20+、Git 和 npm 执行下面命令。请将身份参数替换为项目真实的提交名称和邮箱：

```sh
npx --yes --package=github:Dawn-Inator/vibe-coding-kit vibe-coding-kit install --project-root . --identity-name 'Your Project AI' --identity-email 'ai@example.org' --skill agent-worktree-lifecycle=adopt --skill bugfix-regression-tests=adopt
```

这里的 `ai@example.org` 是格式示意，不能原样使用。命令将 Kit 注册为 `.vibe-coding/kit` submodule，并生成项目自有配置和接入文件；不会替项目配置门禁、提交变更或安装业务依赖。完整安装、技能选择、适配和升级步骤见[中文安装与项目适配指南](INSTALL.md)。

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

The Kit CLI can be bootstrapped with `npx` from this GitHub repository; the project runtime itself remains in the consuming project's pinned submodule. The Kit is not published to the npm registry and does not require a global install. For repeatable setup, pin both the bootstrap package and installed submodule to an approved commit as described in [INSTALL.md](INSTALL.md).

`install` defaults to keeping generated `.agents/skills/` and `.claude/skills/` mirrors out of Git through a managed `.gitignore` block. Projects that intentionally track those projections can install with `--mirror-policy tracked`. Offline `prepare` requires the registered local submodule module cache to contain the exact pinned commit; a cold checkout must be prepared online first.

Windows worktree process and cleanup checks use the system PowerShell 5.1 and native Windows process/file-handle facilities; the kit adds no npm runtime dependency. See [INSTALL.md](INSTALL.md#compatibility-and-project-policy) for failure and recovery behavior.

## Policy boundary

The kit provides reusable mechanisms and examples. Each consuming project defines its own branches, environments, gate commands, authorization rules, deployment policy, and business constraints through project-owned configuration and adapters. No single project's production or gate policy becomes a default for every consumer. Existing integrations, including the LingoFly bridge, may keep thin project-owned bootstrap and adapter wrappers; the wrapper supplies project policy and delegates reusable operations to the pinned kit.

## Backend architecture checks

`node .vibe-coding/kit/cli.mjs backend-check --project-root .` runs a configured Python,
TypeScript or Go source analyzer and fails on structural boundary violations. Copy the matching
`templates/backend-architecture.<language>.json`, set the project's source roots and import namespaces,
then wire the command into the project's chosen gate. See the [setup, rule scope and limitations](tutorial/06-codebase-architecture/backend-guardrails.md).
Shared ownership rules remain language-independent; transaction, API and event semantics remain
project-aware checks. These source analyzers do not certify every backend contract.

## Project lifecycle hooks

The project adapter is a project-owned ES module selected by `.vibe-coding/project.config.json`. The initializer creates a valid adapter with an empty hook map, so a fresh setup uses the kit's default behavior without running project-defined hooks. Projects opt into named exports for `afterCreate`, `beforeCandidate`, `verifyCandidate`, `beforePush`, and `afterLand`; see the [adapter schema](schemas/adapter.schema.json) and [project config schema](schemas/project-config.schema.json).

Hooks run at distinct lifecycle points: `afterCreate` follows worktree creation; `beforeCandidate` runs before finish prepares the candidate; `verifyCandidate` checks the integrated candidate; `beforePush` runs before each push attempt; `afterLand` runs after a successful push. A thrown error, `false`, `{ ok: false }`, or `{ skip: true }` rejects the hook. Failures before the push prevent it. Candidate verification and pre-push hooks must leave the candidate's `HEAD`, working-tree status, and kit pin unchanged. An `afterCreate` failure leaves the created worktree for inspection. An `afterLand` failure is reported after the remote push has succeeded; it cannot undo that push, and the local worktree and branch are preserved for inspection. During `finish`, `verifyCandidate`, `beforePush`, and `afterLand` share the remaining finish-lock hold-time budget, so a slow hook can fail when that budget expires.

## Installation

See [INSTALL.md](INSTALL.md) for the submodule layout, the direct Node CLI, and the distinction between initialization and routine preparation.

## License

The MIT license in [LICENSE](LICENSE) applies to original material authored for this repository by Dawn-Inator. It does not replace or broaden any third-party license. Any third-party component or material must retain its own notices and terms.
