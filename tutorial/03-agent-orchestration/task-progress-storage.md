# 当前工作目录中的任务进度记录

任务面板可以把模型登记的清单、变更历史和心跳读取缓存放到聊天绑定的工作目录里，便于与项目的
`.workspace` 一起查看。路径使用共享契约，避免插件与项目各自定义不同目录。

```js
import { resolveTaskProgressStorage } from './src/contracts/task-progress-storage.mjs';

const storage = resolveTaskProgressStorage({ cwd: trustedChatCwd });
// storage.storageRoot: <trustedChatCwd>/.workspace/codex-task-progress
```

`cwd` 必须来自已验证的聊天身份或项目上下文，并且是非空绝对路径。它不是 Helper 进程的工作目录。
契约只做路径解析，不寻找父级 Git 仓库，不访问文件系统，也不创建或迁移记录。不同工作目录和
worktree 使用各自的 `.workspace`。

采用此契约的 Codex Task Progress 插件在 `storageRoot` 中按聊天隔离记录：

```text
.workspace/codex-task-progress/
  tasks/v3/<聊天 ID 的 SHA-256>/
    events.jsonl
    snapshot.json
  heartbeat/
    bindings.json
    <聊天 ID 的 SHA-256>.jsonl
    <聊天 ID 的 SHA-256>.snapshot.json
```

`events.jsonl` 是追加的清单变更历史，`snapshot.json` 是可以从历史重建的最新状态。
`heartbeat` 只保存选择、读取缓存和观察记录；项目原来的 `heartbeat.md` 仍是心跳台账真源，不因面板
接入而移动或重写。插件的后台程序、日志和本地通信文件不属于这些项目记录。

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

记录迁移、原子写入、冲突处理和是否排除 Git 由消费者负责：迁移前保留旧记录，已有目标记录不得被
静默覆盖，写入失败不得伪装成空任务。任务记录是本地运行数据，默认应从项目 Git 提交中排除。
