# 安装与项目适配

Vibe Coding Kit 以 Git submodule 固定版本。`install` 把 submodule、项目配置和初始文件接入现有项目；以后用 `prepare` 准备父仓库已固定的版本，用 `check` 只读检查。它不会替项目决定门禁、发布或业务规则。

需要后端结构检查时，参考 [Python、TypeScript、Go 配置与接入说明](tutorial/06-codebase-architecture/backend-guardrails.md)，配置实际源码范围及语言工具链，再运行 `node .vibe-coding/kit/cli.mjs backend-check --project-root .`。项目自行将检查接入所选门禁。

## 前置条件

- 一个已初始化、已提交且工作区干净的 Git 项目。首次安装会先注册 submodule，再生成项目文件。
- Node.js 20 或更新版本、Git；使用下面的 `npx` 命令时还需要 npm。
- 一个真实且可用的提交身份。`--identity-name` 和 `--identity-email` 写入项目配置，供 Kit 的 Git 提交身份检查使用；请用项目实际采用的身份，不要把示例占位符照抄。

Kit 不需要发布到 npm registry，也没有额外运行时依赖。通过 GitHub 包直接运行 CLI；安装不会提交文件、安装项目业务依赖、部署或创建云资源。

## 一条命令完成首次接入

在项目根目录运行，并将身份替换为项目真实值：

```sh
npx --yes --package=github:Dawn-Inator/vibe-coding-kit vibe-coding-kit install --project-root . --identity-name 'Your Project AI' --identity-email 'ai@example.org' --skill agent-worktree-lifecycle=adopt --skill bugfix-regression-tests=adopt
```

`ai@example.org` 仅表示参数格式，必须换成真实、可用的项目提交邮箱。首次接入要求仓库干净；命令运行后会新增 submodule 和生成文件，检查输出并按项目流程提交这些变更。

也可以从已有 Kit checkout 调用同一入口：

```sh
node /path/to/vibe-coding-kit/cli.mjs install --project-root /path/to/project --identity-name 'Your Project AI' --identity-email 'ai@example.org' --skill agent-worktree-lifecycle=adopt --skill bugfix-regression-tests=adopt
```

如需固定经审阅的 tag 或 commit，可加 `--ref <tag-or-commit>`。默认使用 Kit 的远端默认版本；要让多个消费者得到相同内容，应显式固定并审阅版本。

若需复现同一套安装入口与 Kit 运行时版本，可分别固定从 GitHub 取得 CLI 的 commit 和写入 submodule 的 commit：

```sh
npx --yes --package='github:Dawn-Inator/vibe-coding-kit#<approved-cli-sha>' vibe-coding-kit install --project-root . --identity-name 'Your Project AI' --identity-email 'ai@example.org' --ref '<approved-kit-sha>' --skill agent-worktree-lifecycle=adopt --skill bugfix-regression-tests=adopt
```

把两个 SHA 都替换为已审阅的完整 commit，并使用项目真实身份。若两者来自同一 Kit 版本，可填写相同 SHA。

## 安装生成什么

Kit 作为名为 `vibe-coding-kit` 的 submodule 注册在 `.vibe-coding/kit`。父项目提交的 gitlink 是版本真源。安装创建 `.vibe-coding/project.config.json`、`.vibe-coding/loading.md`、项目自有 bootstrap 和 adapter、选中 skill 的扩展起始文件，以及默认的忽略/镜像设置。

首次接入后的项目相关目录如下；只在选择 `extend` 时会出现对应 `EXTENSION.md`，memory 和 history 由项目按需维护，不是安装生成的目录：

```text
.vibe-coding/
├── kit/                         # Kit submodule：src/、skills/、tutorial/、templates/ 等公开内容
├── project.config.json          # 项目自有配置
├── loading.md                   # 项目自有加载规则
├── skills/<name>/EXTENSION.md   # 项目自有 skill 扩展（按选择创建）
├── memory/                      # 项目自有，已有内容保留，按需创建
└── history/                     # 项目自有，已有内容保留，按需创建
engineering/automation/vibe-coding/
├── bootstrap.mjs                # 项目自有 submodule 准备入口
└── project-adapter.mjs          # 项目自有生命周期 hooks
.agents/skills/                  # 生成的 skill 镜像
.claude/skills/                  # 生成的 skill 镜像
AGENTS.md / CLAUDE.md            # 由 skills:sync 生成的根指令投影
```

默认镜像策略会忽略前两个镜像目录；它们及根指令文件都是投影，实际生成范围由 skills 同步配置决定。Kit 中的 `templates/` 仅在首次安装时作为输入，不会复制成项目里的模板目录。

默认 `--mirror-policy local` 会把生成的 `.agents/skills/` 与 `.claude/skills/` 镜像留在 Git 之外；项目明确要版本化这些投影时可传 `--mirror-policy tracked`。安装只维护自己标记的 `.gitignore` 区块，会保留其他条目。

项目配置描述项目自身，不是 Kit 的模板真源。默认配置包含 Kit 路径和 URL、adapter 路径、`identity.name` / `identity.email`，以及供项目填写的 `worktrees`、`skills`、`knowledge`、`layout`、`contracts` 配置区域。详见 [配置 schema](schemas/project-config.schema.json)。

如项目已有 `package.json`，安装会合并以下七个脚本；同名脚本已有其他命令时保留原命令并报告冲突。非 JavaScript 项目不会因此得到一个空的 `package.json`，可直接通过 Node 调用 bootstrap 或 CLI。

| 脚本 | 用途 |
| --- | --- |
| `skills:sync` | 准备固定版本并生成 skill 投影 |
| `skills:check` | 准备固定版本并检查 skill 投影 |
| `worktree:begin` | 创建隔离工作树 |
| `worktree:end` | 完成并落地工作树 |
| `worktree:status` | 查看工作树状态 |
| `worktree:cleanup` | 清理符合条件的工作树 |
| `worktree:sync-primary` | 同步主工作树 |

查看当前 CLI 语法：

```sh
node .vibe-coding/kit/cli.mjs help
```

## 选择和适配 skills

重复 `--skill` 指定决策：

```sh
--skill agent-worktree-lifecycle=adopt
--skill bugfix-regression-tests=adopt
--skill my-project-only-skill=local
```

公开 skill 支持 `adopt`、`extend`、`replace:<原因>`、`exclude:<原因>`；`local` 用于项目专属 skill。`extend` 会创建项目自有的 `EXTENSION.md` 起始文件；`replace` 要求已有项目自有的 `SKILL.md` 并提供原因。若至少选择一项公开 skill，命令中未列出的公开 skill 会记录为排除。安装后在项目自己的 `.vibe-coding/project.config.json` 调整这些选择。

先读所选 skill，再决定是否采纳。skill 是方法和边界的说明，不会替项目写出实际 gate、release 命令或产品策略；项目必须自己定义分支、环境、检查命令、发布授权和安全边界。

## 轻量适配生命周期检查

安装生成的 `engineering/automation/vibe-coding/project-adapter.mjs` 有空 hook map，因此默认没有项目检查，不能视作已配置门禁。项目可在 adapter 中注册 `verifyCandidate`，直接以参数数组调用现有检查程序，例如：

```js
import { spawnSync } from 'node:child_process';

export const adapterContract = {
  schemaVersion: 1,
  hooks: { verifyCandidate: 'verifyProjectCandidate' },
};

export function verifyProjectCandidate(context) {
  const result = spawnSync(
    process.execPath,
    ['scripts/check-candidate.mjs', '--project-root', context.projectRoot],
    { cwd: context.projectRoot, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Candidate checks failed (exit ${result.status ?? 'unknown'})`);
  return true;
}
```

将示例脚本和参数改成项目已有的检查入口；避免 shell 字符串拼接，使用可执行文件与参数数组。也可逐步配置 `afterCreate`、`beforeCandidate`、`beforePush`、`afterLand`。hook 返回 `false`、`{ ok: false }`、`{ skip: true }` 或抛错会拒绝该阶段；推送前失败会阻止推送。`afterLand` 在推送成功后执行，若它失败，远端变更已经落地，hook 无法撤销。完整契约见 [adapter schema](schemas/adapter.schema.json)。

## 既有项目、检查与日常准备

成熟项目先评估自身配置、脚本和 adapter。`install --check` 是只读预检：有待创建的注册项或文件、或发现冲突时以非零状态退出；它不会替你解决冲突。首次 `install` 要求干净仓库。文件冲突会在写入前报告并保留已有文件；但 submodule 注册或检出失败可能发生在仓库已变更之后。遇到失败先检查 `.gitmodules`、gitlink 和工作区状态，再按报错处理；不要假设重跑 `install` 会重新初始化。对已注册项目，`install` 只检查现状，不会重建文件或升级 Kit。`prepare` 只准备已固定版本，也不会补做 `init`。

首次 `install` 或对尚未初始化 Kit 的项目首次运行 `init`，会保护已有项目指令与 skill 投影：发现 `AGENTS.md`、`CLAUDE.md` 文件，或 `.agents/skills/`、`.claude/skills/` 目标路径已存在（包括空目录）时，会在初始化写入前拒绝并保留这些内容。已有治理规范或既有 bootstrap/adapter bridge 由项目自行维护；Kit 不会自动搬迁、合并或覆盖它们，也无需删除既有规范来强装。先人工比较来源并决定是否迁移，再选择项目自己的接入方式。

若 `install` 已注册 submodule，但后续固定版本检出或初始化失败，先检查 Git 状态并处理命令报告的脚手架冲突；确认 Kit 已固定且可用后，再按报错给出的 identity 与 options 直接运行该 checkout 的 `node .vibe-coding/kit/cli.mjs init ...`。这是显式的首次初始化，不是重复运行 `install`；确认初始化计划不会覆盖项目文件后再执行。

安装后，典型日常准备和只读检查为：

```sh
node engineering/automation/vibe-coding/bootstrap.mjs prepare
node .vibe-coding/kit/cli.mjs check --project-root .
```

`prepare` 按父仓库 gitlink 检出固定的 Kit 版本，不运行 `install` 或 `init`，也不覆盖项目文件。全新克隆推荐递归取回 submodule；普通 clone 若留下空 submodule，在运行 Kit 命令前在线执行 bootstrap `prepare`。`prepare --offline` 仅在本地已有该精确 commit 时可用；缺失时在线准备。`check` 只读验证当前 Kit checkout 与 gitlink 是否一致，缺项或不一致时非零退出。

已有 LingoFly 式集成的项目应保留自己的 bootstrap 和 adapter 桥接，逐项审查 Kit 可复用能力；不要用首次初始化去替换既有桥接或项目策略。

### 已有 starter-kit 或治理体系的项目迁移

这条路径适用于已经有 loading、skills、根指令或自建桥接的项目。它是人工迁移流程，不是 `install` 的自动升级模式；不要为了让初始化通过而删除项目既有规范。

1. **在项目自己的普通变更分支开始。** 按项目现有流程隔离和评审迁移，先确认工作区状态及未提交改动的归属。
2. **盘点当前真源与调用关系。** 记录现有 loading / 根指令、skills 与扩展、bootstrap/adapter、gate 和 release 入口，以及引用它们的脚本、自动化和测试。标出已有的双门状态机、发布授权和恢复规则，迁移时继续由项目负责。
3. **注册已审阅的固定 Kit submodule。** 如果 `.vibe-coding/kit` 已被旧 checkout 占用，先保留它并人工选定迁移/归档位置；不要直接覆盖。确认目标路径可用后，注册并固定版本。先把选定 SHA 的 gitlink 放入父项目 index，再运行 prepare：

   ```sh
   git submodule add --name vibe-coding-kit https://github.com/Dawn-Inator/vibe-coding-kit.git .vibe-coding/kit
   git -C .vibe-coding/kit fetch --no-tags origin '<approved-ref>'
   git -C .vibe-coding/kit rev-parse --verify --end-of-options 'FETCH_HEAD^{commit}'
   git -C .vibe-coding/kit checkout --detach '<resolved-full-commit-sha>'
   git add -- .vibe-coding/kit
   ```

   检查父项目 index 中的 gitlink 确实指向审阅过的 SHA。此时还不要运行依赖项目配置的 bootstrap。
4. **只补齐缺少的项目文件。** 逐项比较 Kit `templates/` 与项目现状，以模板为参考，手工补建缺少的 `project.config.json`、bootstrap 或 adapter；已有配置要保留并按 [配置 schema](schemas/project-config.schema.json) 合并必要字段，不要覆盖。填写实际 Kit URL/path、项目提交身份与 adapter 路径。对每个公开 skill 都在配置中作出明确选择（`adopt` / `extend` / `replace` / `exclude`；`replace` 和 `exclude` 写明理由）。此时只准备并验证固定 Kit pin，不要生成 skill 或根指令投影：

   ```sh
   node engineering/automation/vibe-coding/bootstrap.mjs prepare
   node .vibe-coding/kit/cli.mjs check --project-root .
   ```

   这些命令要求项目配置、submodule 注册和 bootstrap 已按上文完成。skills composer 要求所有公开 skill 都有决策；不要把未决项默认为采纳。
5. **迁移规则并接通项目已有门禁。** 保留原有 canonical loading，将原来根指令中的有效规则合并进项目自有 `.vibe-coding/loading.md`，检查合并结果后，再运行 skill sync/check：

   ```sh
   node .vibe-coding/kit/cli.mjs skills sync --project-root .
   node .vibe-coding/kit/cli.mjs skills check --project-root .
   ```

   这一步才生成根指令与 skill 镜像；确认规则已进入 canonical source 后，才将新生成的 `AGENTS.md` / `CLAUDE.md` 作为项目投影使用。adapter 应调用项目已经在用的 gate 命令，并保留成熟状态机和发布授权；空 hook adapter 是 no-op，不能当作 gate 已就绪。
6. **用有限范围验证，再退役重复入口。** 运行迁移涉及的项目测试和 bounded checks，复核配置/生成 diff，验证 `skills check`、冷克隆后的 submodule hydrate、项目自己的 worktree begin/finish 路径，以及缺失或 dirty kit pin 会被拒绝。只有在调用关系已迁移且对应测试通过后，才在普通提交中退役旧的重复核心实现；未完成迁移的消费者继续使用各自原有桥接。

## 有意升级 Kit 版本

日常工作不执行 `git submodule update --remote`。升级是项目自己的代码变更：先确认没有未提交的 Kit 子模块修改，在父项目新工作分支中 fetch 并审阅获批的上游 tag/commit，解析为完整 commit SHA，再把子模块 checkout 到该 SHA。然后先将 gitlink 加入父项目暂存区，使父项目 index 成为 `prepare` 的固定版本依据：

```sh
git status --short
git switch -c codex/upgrade-vibe-coding-kit
git -C .vibe-coding/kit fetch origin
git -C .vibe-coding/kit rev-parse --verify --end-of-options '<approved-ref>^{commit}'
git -C .vibe-coding/kit checkout --detach <reviewed-full-commit-sha>
git add .vibe-coding/kit
node engineering/automation/vibe-coding/bootstrap.mjs prepare
node .vibe-coding/kit/cli.mjs check --project-root .
```

将 `<approved-ref>` 替换为已审阅的 tag 或 commit；确认上一条解析出的 SHA 后，把它填到 checkout 命令。之后同步并检查 skills。若项目有 pnpm 脚本，可运行 `pnpm skills:sync` 和 `pnpm skills:check`；否则直接通过 Node 调用固定 checkout：

```sh
node .vibe-coding/kit/cli.mjs skills sync --project-root .
node .vibe-coding/kit/cli.mjs skills check --project-root .
```

再运行项目自己的相关检查，审查 gitlink 与配置 diff，并提交正常升级变更。

升级不会覆盖项目模板、配置、adapter、loading、skills 扩展、memory 或 history。新版本的 skill 若需要项目作出新的采纳决定，应先更新项目配置再生成投影；不要仅因模板变化就覆盖项目文件。若需要回退，正常提交上一版 gitlink 并重新 `prepare`、`check`；不要用 reset 或强制改写历史。其他消费者仍固定在各自审阅过的版本。

<a id="compatibility-and-project-policy"></a>

## 项目所有权与兼容范围

Kit checkout 中的 `src/`、`skills/`、`tutorial/`、`schemas/` 是 Kit 提供的可复用内容。消费项目自己维护 `.vibe-coding/project.config.json`、`.vibe-coding/loading.md`、本地 skills 与扩展、adapter、bootstrap、memory、history 和项目文档。skill 镜像、根指令文件等是生成投影，应修改其源文件后再用项目工具重生。

`templates/` 只供首次脚手架生成。后续 `prepare`、skill 同步和 Kit 升级不会将模板复制到项目中；初始化后生成的配置与 adapter 由项目维护。

Kit 要求 Node.js 20+ 和 Git。Windows worktree 检查使用系统 PowerShell 5.1 及原生进程/文件句柄能力；Kit 不引入 npm 运行时依赖。被系统策略阻止时相关操作会失败关闭。Windows 清理也会拒绝 junction / symlink；若信号排空失败，Kit 会保留恢复锁，确认 Kit 管理的 Git 操作已全部停止前不要移除该锁。
