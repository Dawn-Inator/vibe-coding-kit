# Vibe Coding Kit

Vibe Coding Kit is a versioned set of reusable AI-assisted engineering tools, project templates, skills, and tutorials. It is designed to be consumed by projects with their own architecture, workflow, and release policies.

## 中文快速开始

在一个已提交且工作区干净的 Git 项目根目录，用 Node.js 20+、Git 和 npm 执行下面命令。请将身份参数替换为项目真实的提交名称和邮箱：

```sh
npx --yes --package=github:Dawn-Inator/vibe-coding-kit vibe-coding-kit install --project-root . --identity-name 'Your Project AI' --identity-email 'ai@example.org'
```

这里的 `ai@example.org` 是格式示意，不能原样使用。默认将公开 skill 复制到项目自有的 `.vibe-coding/skills/`，再同步到工具目录；项目可按需调整。新项目默认关闭可选类别，已检测到的 Codex Task Progress 安装会作为复用默认值；例如可附加 `--optional task-progress=on`。安装不会因可选组件配置登录账号、创建仓库或云资源。命令将 Kit 注册为 `.vibe-coding/kit` submodule，并生成项目自有配置和接入文件；不会替项目配置门禁、提交变更或安装业务依赖。完整安装、技能选择、适配和升级步骤见[中文安装与项目适配指南](INSTALL.md)。

## Repository and consumer path

This repository is the public source of the kit. A consuming project checks it out as a Git submodule at `.vibe-coding/kit/`; that path is a consumer convention and is not an extra directory inside this repository. The parent project's gitlink pins the exact kit commit used by that checkout.

The runtime under `src/` is called directly from the pinned checkout. Consumers must not copy the runtime into their own source tree. Files under `templates/` are initial project scaffolding. By default initialization copies public skills into project-owned `.vibe-coding/skills/` sources and generates tool mirrors. Upgrades do not overwrite or automatically update these snapshots; projects selectively merge upstream changes. Explicit `adopt` and `extend` selections retain shared-source behavior.

## Contents

- [`skills/`](skills/) contains the current reusable skills (backend, frontend, data, workflow and agent-orchestration). Projects select and extend them according to their own needs.
- [`optional/`](optional/) contains the [`catalog.json`](optional/catalog.json) and sources grouped by physical type under [`plugins/`](optional/plugins/) and [`skills/`](optional/skills/); the [optional components guide](optional/README.md) maps these paths to installation categories.
- 域名与对象存储规范：[`domain-boundary`](skills/domain-boundary/SKILL.md) 提供 `api` / `dev-api` 等命名模板；[`object-storage-layout`](skills/object-storage-layout/SKILL.md) 提供分桶、环境隔离与对象目录规则。
- [`tutorial/`](tutorial/) explains the methods and tradeoffs behind the skills. Tutorial examples are illustrative, not mandatory project policy.
- [`guidance/environment-and-secrets.md`](guidance/environment-and-secrets.md) provides an adoptable baseline for configuration naming, precedence, and secrets.
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

## Environment configuration

`src/env-config/index.mjs` exports `createEnvironmentRenderer` for projects that
keep a shared JSON base and a JSON overlay per environment. The consumer supplies
its own stage names, paths and generated-file banner. Objects merge recursively;
arrays, scalars and null are replaced by the overlay. `render` and `text` read
one environment; `check` returns stale environment names without writing; `regen`
validates all inputs before updating output files. Inputs must be JSON objects;
unsafe prototype keys and unknown stages are rejected. Consumers own secret
storage and must not put secret values into checked-in application files. A selected private secrets repository may contain plaintext values.

`resolveBranchEnvironment` validates a consumer-supplied branch-to-environment
map and resolves a known branch or explicit environment. Conflicting or unknown
inputs fail. The mapping selects configuration only: it grants no deployment
permission and does not verify a release candidate. Projects must keep their own
admission checks and special candidate rules.
