# 当前工作目录中的任务进度记录

Kit 可以在经过验证的聊天工作目录中保存普通任务清单及完整变更历史，也可以读取项目 Heartbeat 并
投影为只读任务视图。存储规范和迁移由共享 Kit 拥有，不依赖已移除的 Task Progress 插件、Hooks 或后台服务。

接手任务时，按[任务交接规范](../../skills/manage-knowledge-artifacts/references/authoring-details.md#task-handoff)
查找进度来源，并根据接手人能否访问同一工作区选择交接文件的存放位置。

```js
import { resolveTaskProgressStorage } from './src/contracts/task-progress-storage.mjs';

const storage = resolveTaskProgressStorage({ cwd: trustedChatCwd });
// storage.storageRoot: <trustedChatCwd>/.workspace/codex-task-progress
// storage.cacheRoot:   <trustedChatCwd>/.tmp/codex-task-progress
```

`cwd` 必须来自已验证的聊天身份或项目上下文，并且是非空绝对路径。它不是 Helper 进程的工作目录。
契约只解析路径，不寻找父级 Git 仓库，不访问文件系统，也不创建或迁移记录。不同工作目录和 worktree
使用各自的 `.workspace`。

## Direct API workflow

Task Progress 插件及其 `task_progress_*` MCP 工具已移除。心跳与编排直接使用 Kit API；不要安装旧插件或调用已不存在的工具。

- 使用可信的当前聊天 ID 与 cwd，通过 `WorkspaceTaskStorage` 解析已有存储与来源关系；未知身份或未解决的来源关系应报告缺口，不能猜测身份或另建记录。
- 无来源绑定的普通任务使用 `TaskStore.getReadOnly` 读取；仅在不存在记录时用 `initialize`。用 `update` 记录实际里程碑，用 `rescope` 修订范围，保留稳定 ID、证据和历史。
- 每次写入使用当前 revision 和稳定的 requestId；同一逻辑写入重试沿用 requestId。同一存储根由一个写入进程串行维护。
- 需要生命周期验收时，初始化或更新显式传入 `lifecycle: true`；分支、集成、推送及剩余事项审计完成后调用 `complete`。历史周期由 `archives` 读取。
- 关联到 Heartbeat 的任务投影只读。通过 [Heartbeat writer API](../../skills/agent-task-supervision/references/ledger-api.md) 更新原始 Items、派发关联与审计，不创建第二份进度真源。

`taskhistory.md`、`heartbeat.md` 及既有路径保持兼容。面板或后台进程均不是心跳定时执行器；是否启动定时监督，仍由项目编排指引及用户授权决定。

## 普通聊天任务记录

Kit `WorkspaceTaskStorage` 根据可信的当前 cwd 路由记录；`TaskStore` 处理任务事件。每个聊天按线程 ID 的
SHA-256 隔离：

```text
<cwd>/.workspace/codex-task-progress/
  tasks/v3/<thread-sha256>/
    heartbeat.md       # 最新任务状态的可读投影
    taskhistory.md     # 完整任务事件、来源关系和迁移标记
  .gitignore           # 忽略运行时记录
<cwd>/.tmp/codex-task-progress/<thread-sha256>/
  ...                  # 可重建的读取缓存
<helper-app-root>/task-routing/
  heartbeat.md         # 最新聊天 cwd 路由的可读投影
  taskhistory.md       # 持久路由历史
```

`taskhistory.md` 是普通任务的持久历史，采用带 schema 版本标记的 Markdown 记录容器，包含结构化任务事件，
也包含显式或自动 Heartbeat 来源绑定及关系迁移标记。`heartbeat.md` 可从最后一条任务事件重建；它不是历史
来源。新写入必须经过 Kit `TaskStore`，不可手动往 head 追加已发生的事件。TaskStore 的存储根一次只允许
一个写进程；需要跨进程并发控制时由调用方协调。

`WorkspaceTaskStorage.hasRecoverableTasks()` 只读检查已知的应用记录、受验证的项目路由和旧索引，
用于判断是否有可恢复的普通任务或来源关联；已完成任务的历史也计入。观察不会迁移、加锁、创建目录
或修改历史，不会递归扫描任意项目。此结果只表示存在任务记录，不授予重启宿主的权限，也不证明面板
连接或可见显示正常。宿主适配器必须另外验证当前进程及连接身份。

普通短任务无需建立 Heartbeat。若当前任务已绑定某份台账，或完整发现扫描得到唯一精确关联的台账，该台账
替代任务面板中的清单视图；原有普通任务历史仍保存在 `taskhistory.md`。`TaskSourceRelations` 的 `get`、
`set` 和 `resolve` API 持久化绑定。显式 `null` 表示明确取消绑定；缺少历史关系则表示旧关系尚未迁移，二者
不能混同。不要在插件或缓存中另建绑定真源。来源绑定期间，面板任务变更 API 不能改写只读投影。

任务历史也可通过 Kit `TaskStore.history()` 分页读取。修订冲突和请求 ID 冲突必须保持为错误；精确重试保持
幂等。未知状态不得推断为完成。来源证据、稳定 ID、历史状态及有效父子关系均须保留，不能只保存总百分比。

## Agent 与任务范围关联

派发后，将工具实际返回的原生 agent thread ID 写入普通任务的既有 `TaskStore.rescope` 目标或条目：`agent: { threadId, path? }`，使用当前 revision 并保留仍需跟踪的范围。当前周期中省略该字段会按条目 ID 保留原关联（包括移动）；显式 `agent: null` 清除，新周期不继承。目标关联可由子项继承，子项可显式覆盖或清除。Kit 从现有规范叶节点派生模块进度，不复制清单或新建存储；agent 进度不等于父任务完成。

绑定的只读 Heartbeat 由来源写入方通过现有 Items 工作流维护可选 `agent_thread_id` 或精确且唯一的 owner 路径；面板不能改写来源，也不能补造缺失的证据。运行时事件只是有时间的记录观察，不保证进程实时状态；不完整覆盖时已观察数仅是下界，未知不是零，只有当前计划分母准确时才显示比例。

## 项目 Heartbeat 台账

项目 Heartbeat 采用当前头部加完整历史文件：

```text
<project>/.workspace/task/<session>/heartbeat.md        # 当前 wake 与 Items
<project>/.workspace/task/<session>/taskhistory.md      # 完整 wake 历史
<project>/release.md                                    # 自定义头部示例
<project>/release.taskhistory.md                        # 自定义头部的历史 companion
<project>/heartbeat.md.legacy                           # 新建或迁移时保留的原始字节
```

使用 Kit `readHeartbeatLedgerPair({root, path})` 兼容读取旧单文件或完整文件对；它是只读的。UI 展示、自动
发现和普通读取都不能迁移一个仍由其他 writer 使用的旧台账；旧单文件在所有者明确接管之前保持原状，报告
来源就是该头部文件。使用
`inspectHeartbeatLedgerPair(pair, options)` 校验逻辑完整台账，并让每条 wake/Items 行指向真实来源文件和行号。
`mode: 'items'` 和 `mode: 'format'` 只检查当前头部，不认证历史或 current 审计；history/current 模式读取
完整逻辑历史。来源行号可能落在头部或 companion，消费者应展示 API 提供的物理来源。
`readProjectHeartbeat` 的 `source.historyPath` 对 legacy
单文件等于原始 `headPath`；对 paired ledger 指向 companion。配对历史中的 archived wakes 指向 companion，
当前头部 wakes 和 Items 指向 head。

### 新建和更新前校验

新台账先在内存中生成完整文本，包含当前 Items 和首次 wake，再调用 Kit 的
`createHeartbeatLedgerPair`。父目录必须已经存在，head、history 和 `.legacy` 备份路径必须全部不存在；
新建没有旧版本，因此不传 `expectedContentHash`。

```js
import {
  createHeartbeatLedgerPair,
  readHeartbeatLedgerPair,
} from './src/supervision/heartbeat-ledger-files.mjs';

createHeartbeatLedgerPair({
  root,
  path,
  text,
  legacyWritersQuiescent: true,
  // orchestration, // 可选，只记录实际观察及证据
});
const created = readHeartbeatLedgerPair({ root, path });
```

需要预检时，用 `inspectHeartbeatLedger(text, { mode: 'format', ledgerPath: path })` 检查内存中的候选。
`inspectHeartbeatLedger` 从 `src/supervision/heartbeat-ledger-api.mjs` 导入。`format` 检查存在的当前 Items，
以及候选内所有可识别 wake 的时间与 orchestration 元数据，`latest` 不把检查限制为最后一段。它兼容没有
Items 的旧存储，但这不免除新监督审计的 Items 要求；此模式始终不认证 current，预检也不替代 writer 的强制检查。
新建、`writeHeartbeatLedgerPair`、`appendHeartbeatWake` 和 `recordHeartbeatAgentAssignments` 都在
发布最终候选之前校验。格式不合法会抛出带 `findings` 的 `HEARTBEAT_LEDGER_INVALID`，不会写入 head、
history 或备份；已有文件保留原字节。根据诊断修正候选后再通过 API 写入，不能直接覆盖或追加来绕过校验。

例如，source 使用 `owner:intake.md` 等支持的前缀，不能填 `user-2026-11-21`；阻塞状态使用
`blocked <- Owner/ops production functionSwitch.redPoint value`，明确所等待的资源。字面值 `unknown`
是合法的未完成状态，缺失证据时保持未知；`ready` 仍由 Items 规则拒绝，不能自动改成已调度。格式通过
不证明实际活动、验收或落地；写入后回读 pair，再用严格 `current` 模式审计。

禁止先用 `writeFile`、重定向或直接追加发布原始 seed，再调用 migrate；非法 seed 在迁移前已经可能被插件
发现。create 会先验证完整原文，再原子发布这个已验证的 seed，并在同一 writer 锁内完成 pair 切换。
文件 I/O 中断时，可能留下合法单文件 seed 或可恢复的 pair；应回读确认状态，再按下文迁移或恢复，不能
覆盖已有文件或盲目重跑 create。格式拒绝与这种 I/O 中断不同：格式拒绝不会写入 head、history 或备份。
新建使用 create；已有 pair 先读取新鲜版本再使用 write/append/assignment API。migration 和 recovery
用于既有历史数据的兼容切换或中断恢复，不替代正常新建和更新。

### 迁移既有单文件

旧单文件转为双文件属于 writer-owned 显式切换：只有 writer 在整个事务期间停止旧 writer 并确认台账
quiescent 后，才能设置 `legacyWritersQuiescent: true` 并传入新鲜的 `expectedContentHash`。先读：

```js
const pair = readHeartbeatLedgerPair({ root, path });
const writeOptions = {
  root,
  path,
  legacyWritersQuiescent: true,
  expectedContentHash: pair.contentHash,
};
migrateHeartbeatLedgerPair(writeOptions);
```

这个 flag 是调用方对真实 writer 状态的断言；Kit 的跨进程互斥锁只协调 Kit writers，不能停止或锁住仍在
直接追加旧文件的外部 writer。不能由发现、UI display 或只读 API 触发切换。写入会检查新鲜哈希；发生
版本冲突就 fail closed。完成切换时，原始完整字节保留到 `.legacy`，既有 wake 历史复制到带版本标记的
companion，最新 wake 与 Items 留在头部。新 wake 使用 `appendHeartbeatWake` 或
`writeHeartbeatLedgerPair` 并提供相同所有权断言和刚读取的 `expectedContentHash`，来源须已通过 create 或
迁移成为 pair，不能再直接追加到头部。迁移保存既有历史原始字节，不把旧记录当作新候选重新套用格式门禁。

### 恢复中断发布及后续更新

如果 history 已落盘而发布 head 中断，`readHeartbeatLedgerPair` 会拒绝将不完整 pair 当成完整台账；用只读
`readHeartbeatLedgerPairVersion({root, path})` 获取当前原始 hash，再把 hash 和 ownership 断言传给
`recoverHeartbeatLedgerPair`。Kit 会校验 v3 history body、不可变备份、计划 head 与旧 head hash，仅当当前
head 仍等于旧 head 或计划 head 时才完成发布；其他情况是冲突，禁止手工编辑任一副本。恢复按已记录的
计划完成发布并保留历史字节，不是绕过新候选校验的另一种写入方式。

```js
const rawVersion = readHeartbeatLedgerPairVersion({ root, path });
recoverHeartbeatLedgerPair({
  root,
  path,
  legacyWritersQuiescent: true,
  expectedContentHash: rawVersion.contentHash,
});
```

对已有 pair 的每次普通写入都重新读取 hash，再设置 ownership assertion：

```js
const current = readHeartbeatLedgerPair({ root, path });
appendHeartbeatWake({
  root,
  path,
  legacyWritersQuiescent: true,
  expectedContentHash: current.contentHash,
  wakeText,
});
```

`readProjectHeartbeat` 可独立显示配置来源或项目中最近记录的来源。它不证明工作仍在运行，时间戳也不能当作
实时活动证据。项目显示与当前聊天的任务绑定仍是两个概念；项目卡片显示的来源可以和任务绑定来源不同。
当 discovery 的 `complete` 为 false 时，不能宣称候选唯一或不存在，应明确保留不确定性。只有 unfenced 文本里
唯一、独立的 `thread:`、`thread_id:` 或 `threadId:` 字段与线程 ID 完全匹配时才自动关联。

重复发现应使用 Kit `WorkspaceTaskStorage` 持有的 `HeartbeatDiscoveryIndex`，不要在插件或前端另建来源权威缓存。
该索引按规范项目与扫描范围，在聊天服务和项目展示间共享有界候选发现，仅在递归 watcher 有效时复用；写入可请求
强制新扫描。watcher 报错/关闭或递归监听不可用时，缓存不再受保护，后续走新扫描。自动扫描跳过 `.tmp`，显式
指定 `.tmp` 路径仍可读取但不复用索引。候选选择使用规范摘要解析，完整审计只针对最终选中来源；文件/深度限制、
嵌套 Git/符号链接边界和精确线程关联继续生效。规范化及 CPU 守卫为单次调用状态，缓存不保证零 I/O。

项目 Heartbeat 摘要的 30 秒缓存按配置范围隔离，并从刷新完成时开始计时。同范围刷新 pending 时，可返回最近摘要用于
展示，但必须将其标记为未认证；切换到没有已验证快照的新范围时应清空旧展示。pending 展示不改变来源权威。

## 迁移、路由与缓存

旧 JSONL 事件、JSON 快照、Heartbeat 绑定 JSON 和 `workspace-storage-index.json` 都只作为兼容迁移输入，旧文件
迁移后保留为只读备份，不再是新写入目标。TaskStore 会检查旧 JSONL 与 Markdown 事件序列是否同一前缀；若
内容分叉，则报冲突，保留两份数据，不做静默覆盖或合并。旧 workspace index 只用于还原首次可信路由，新的
路由历史由 Kit 存在 helper app root 的 `task-routing/` 中，因为它需要跨项目 cwd 移动后仍能定位任务记录。

工作区移动会复制普通任务 history 并记录新的路由，但不会带走旧项目的 Heartbeat 来源绑定。cache 位于
`.tmp/codex-task-progress/<thread-sha256>/`，可以重建；删除 cache 不得丢失任务 history、来源关系、workspace
routing 或项目 Heartbeat 历史。helper app root 的路由历史是持久数据，不是 cache，也不等同于项目任务记录。

消费者可以把 Kit 固定到具体 Git SHA，并从固定依赖导入统一实现：

```js
import { resolveTaskProgressStorage } from 'vibe-coding-kit/src/contracts/task-progress-storage.mjs';
import { TaskStore } from 'vibe-coding-kit/src/tasks/task-store.mjs';
import { TaskSourceRelations } from 'vibe-coding-kit/src/tasks/task-source-relations.mjs';
```

发布构建可以把固定依赖打包进 Helper；运行时不应再复制一份路径解析、TaskStore 或来源关系实现。普通任务
运行数据默认从 Git 提交中排除。Kit API、路径含义与冲突处理规则由 [task-progress Skill](../../skills/task-progress/SKILL.md)
及其存储参考统一维护。
