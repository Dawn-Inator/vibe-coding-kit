# 当前工作目录中的任务进度记录

任务面板可以在经过验证的聊天工作目录中保存普通任务清单及完整变更历史，也可以读取项目 Heartbeat 并
投影为只读任务视图。存储规范和迁移由共享 Kit 拥有；插件只适配 Kit API 与展示数据。

```js
import { resolveTaskProgressStorage } from './src/contracts/task-progress-storage.mjs';

const storage = resolveTaskProgressStorage({ cwd: trustedChatCwd });
// storage.storageRoot: <trustedChatCwd>/.workspace/codex-task-progress
// storage.cacheRoot:   <trustedChatCwd>/.tmp/codex-task-progress
```

`cwd` 必须来自已验证的聊天身份或项目上下文，并且是非空绝对路径。它不是 Helper 进程的工作目录。
契约只解析路径，不寻找父级 Git 仓库，不访问文件系统，也不创建或迁移记录。不同工作目录和 worktree
使用各自的 `.workspace`。

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

## 项目 Heartbeat 台账

项目 Heartbeat 采用当前头部加完整历史文件：

```text
<project>/.workspace/task/<session>/heartbeat.md        # 当前 wake 与 Items
<project>/.workspace/task/<session>/taskhistory.md      # 完整 wake 历史
<project>/release.md                                    # 自定义头部示例
<project>/release.taskhistory.md                        # 自定义头部的历史 companion
<project>/heartbeat.md.legacy                           # 迁移保留的旧文件原始字节
```

使用 Kit `readHeartbeatLedgerPair({root, path})` 兼容读取旧单文件或完整文件对；它是只读的。UI 展示、自动
发现和普通读取都不能迁移一个仍由其他 writer 使用的旧台账；旧单文件在所有者明确接管之前保持原状，报告
来源就是该头部文件。使用
`inspectHeartbeatLedgerPair(pair, options)` 校验逻辑完整台账，并让每条 wake/Items 行指向真实来源文件和行号。
`mode: 'items'` 只读当前头部的 Items；history/current 模式读取完整逻辑历史。来源行号可能落在头部或
companion，消费者应展示 API 提供的物理来源。`readProjectHeartbeat` 的 `source.historyPath` 对 legacy
单文件等于原始 `headPath`；对 paired ledger 指向 companion。配对历史中的 archived wakes 指向 companion，
当前头部 wakes 和 Items 指向 head。

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
`writeHeartbeatLedgerPair` 并提供相同所有权断言和刚读取的 `expectedContentHash`，不能再直接追加到头部。

如果 history 已落盘而发布 head 中断，`readHeartbeatLedgerPair` 会拒绝将不完整 pair 当成完整台账；用只读
`readHeartbeatLedgerPairVersion({root, path})` 获取当前原始 hash，再把 hash 和 ownership 断言传给
`recoverHeartbeatLedgerPair`。Kit 会校验 v3 history body、不可变备份、计划 head 与旧 head hash，仅当当前
head 仍等于旧 head 或计划 head 时才完成发布；其他情况是冲突，禁止手工编辑任一副本。

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
