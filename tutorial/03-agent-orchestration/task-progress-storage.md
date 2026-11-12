# 当前工作目录中的任务进度记录

任务面板可以在聊天绑定的工作目录里保存普通任务清单及变更历史，也可以读取项目心跳台账并投影为
只读任务视图。路径使用共享契约，避免消费者各自定义不同目录。

```js
import { resolveTaskProgressStorage } from './src/contracts/task-progress-storage.mjs';

const storage = resolveTaskProgressStorage({ cwd: trustedChatCwd });
// storage.storageRoot: <trustedChatCwd>/.workspace/codex-task-progress
```

`cwd` 必须来自已验证的聊天身份或项目上下文，并且是非空绝对路径。它不是 Helper 进程的工作目录。
契约只做路径解析，不寻找父级 Git 仓库，不访问文件系统，也不创建或迁移记录。不同工作目录和
worktree 使用各自的 `.workspace`。

Kit exports ordinary task storage and the read-only heartbeat adapter. The Kit package does not bootstrap a
Zod runtime dependency: inject the caller's Zod instance when creating schemas. A TaskStore must have one
writer process for its storage root; callers serialize access across processes.

```js
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { createTaskProgressSchemas } from './src/tasks/task-contract.mjs';
import { TaskStore } from './src/tasks/task-store.mjs';
import { discoverHeartbeatLedgers, projectHeartbeatTask } from './src/tasks/heartbeat-task-source.mjs';
import { inspectHeartbeatLedger } from './src/supervision/heartbeat-ledger-api.mjs';

const schemas = createTaskProgressSchemas(z);
const taskStore = new TaskStore(storage.storageRoot, { schemas }); // ordinary mutable task state
const root = await realpath(trustedChatCwd);
const candidates = await discoverHeartbeatLedgers({ root, threadId });
const associated = candidates.filter((candidate) => candidate.associated);
// Use an explicitly chosen/bound path if discovery is ambiguous; do not guess among candidates.
if (associated.length === 1) {
  const path = associated[0].path;
  const text = await readFile(path, 'utf8');
  const info = await stat(path);
  const report = inspectHeartbeatLedger(text, { mode: 'items', ledgerPath: path });
  const taskView = projectHeartbeatTask({
    report,
    root,
    threadId,
    path,
    contentHash: createHash('sha256').update(text).digest('hex'),
    modifiedAt: info.mtime.toISOString(),
  }); // read-only view; keep out of TaskStore mutations/events
}
```

Discovery associates a ledger only when its unfenced text contains one standalone metadata field such as
`thread: <id>`, `thread_id: <id>`, or `threadId: <id>` with an exact value. Mentions in titles, evidence, or prose do
not bind a source; conflicting or multiple IDs remain unassociated and require an explicit selection. Pass the same
canonical real project root used for discovery to the pure projector; it checks normalized root/path containment.

采用此契约的 Codex Task Progress 插件在 `storageRoot` 中按聊天隔离记录：

```text
.workspace/codex-task-progress/
  tasks/v3/<聊天 ID 的 SHA-256>/
    events.jsonl
    snapshot.json
  sessions/<聊天 ID 的 SHA-256>/heartbeat/
    bindings.json
    <聊天 ID 的 SHA-256>.jsonl
    <聊天 ID 的 SHA-256>.snapshot.json
```

`events.jsonl` 是追加的清单变更历史，`snapshot.json` 是可以从历史重建的最新状态。
普通短任务使用共享 Kit 的 TaskStore，不需要建立心跳台账。若聊天已绑定到某份心跳台账，或发现唯一精确
关联的台账，该台账替代任务面板中的清单展示；原有本地普通任务记录保留为休眠记录。来源绑定期间拒绝
通过面板任务变更 API 修改投影视图。投影消费者不移动或重写原始 `heartbeat.md`，也不创建任务事件或
快照来冒充它；心跳来源仍由项目现有的账本流程维护。

投影只采用台账检查器解析出的现有行 ID、标题、状态和证据。原始状态保存在来源元数据中；未知状态保持
未完成，完成状态必须有来源证据，不能从清单存在本身推断整个会话已交付。非法或重复的行 ID、检查器
报告的错误，以及无法安全解析的父子链接必须明确呈现为错误或来源风险，不能静默丢弃行。`tracking`
父行有有效子链接时只把子项作为进度叶子，避免重复计算。此投影不签发“已验证”证据，也不认证整个
心跳周期。任务结束的汇报仍按 [completion guidance](../../skills/task-progress/SKILL.md)；计划编写按项目
提供的 `normal-plan` 指引。

心跳观察的消费者缓存位于 `sessions/<聊天 ID 的 SHA-256>/heartbeat/` 下；它只缓存读取结果，
不能成为台账的第二真源。插件自己的日志和本地通信文件不属于这些项目记录。

消费者从其固定版本的 Kit checkout 调用共享 API，通常位于
`.vibe-coding/kit/src/contracts/task-progress-storage.mjs`；也可以由项目明确指定受信任的 Kit 路径。
机器上已配置的 Kit checkout 可以供未安装项目 Kit 的聊天使用。运行时源码保持在 Kit 中，不另建一份
消费者路径解析实现。

需要构建独立 Helper 的插件也可以声明固定到 Kit 提交的 Git 包依赖，并从该依赖静态导入：

```js
import { resolveTaskProgressStorage } from 'vibe-coding-kit/src/contracts/task-progress-storage.mjs';
```

发布构建可以把这个固定依赖打包进生成的 Helper；无需让用户机器在运行时另装 Kit，也无需把一份
Kit 运行时源码提交到插件自己的源码目录。对应的 `.d.mts` 提供只读路径结果类型。

TaskStore 负责普通任务事件的持久追加、原子快照、修订号、幂等请求与冲突处理；其存储根目录只能由
单一写入进程使用。消费者负责提供可信聊天身份、选择与路由来源、迁移旧记录并决定是否从 Git 排除。
迁移时保留旧记录，已有目标记录不得静默覆盖。任务记录是本地运行数据，默认应从项目 Git 提交中排除。
