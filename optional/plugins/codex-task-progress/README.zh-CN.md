# Codex Task Progress

基于 [Ezra-Y/codex-goal-progress](https://github.com/ezra-y/codex-goal-progress) 的Kit 中维护的改造，保留原始 Git 历史、作者归属和 MIT 许可证。

0.5.4 的有界 Kit Heartbeat 发现会在单次扫描中复用规范化项目根路径与 Git 边界检查结果，并在扫描结束后丢弃缓存。仍遵循配置的文件数/深度限制，保持嵌套 Git 与符号链接边界以及精确线程关联行为。

0.5.3 将 Heartbeat 历史整理为按时间分组的卡片；展开记录可查看可用原始字段的有界预览，原文件保留完整记录。诊断信息默认收起以保持摘要简洁，历史与心跳视图继续支持分页、宿主主题和响应式布局。项目摘要按配置范围复用 30 秒缓存，同一项目复用进行中的读取；`get` 在完成关联任务来源校验后独立返回，项目心跳展示在后台加载。来源代次变化会立即启动刷新，不等待旧请求，每两秒轮询；关联来源 watcher 只失效该来源的缓存。胶囊始终停靠并居中，不允许横向滚动或拖动；忽略旧版本保存的浮动偏好。点击模块不显示黑色描边，同时保留键盘焦点。未完成任务按原始清单新增顺序倒序显示在顶部，已完成任务稳定留在底部；只改变展示，不改写记录。现有工具输入、存储格式和来源权威行为保持兼容，`get` 输出可带有可选的 `heartbeatPending` 状态。

0.5.0 在聊天顶部使用 44px 圆弧胶囊，并沿下边缘显示总进度。点击胶囊查看真实任务的子模块（`objectives`），每个模块都有进度条；继续点击模块，查看节点（`items`）的状态、说明和证据。右侧两个 40px 圆形按钮分别打开历史与心跳，同一时间仅展开一个面板。总进度按有效必做清单项计算，新增任务可以使进度回退；没有清单时显示真实空状态。模型通过 task_progress_* 工具维护记录，无需创建原生 Goal。

0.5.1 的启动恢复通过 Kit 只读接口识别普通任务历史和来源关联，也覆盖已完成任务及旧记录。有经过身份校验的 CDP 连接时，Helper 自动重连并恢复当前聊天的顶部组件。自动恢复不会授权终止或重启 Codex；当前进程未开放 CDP 时返回 `*_PENDING_CDP_UNAVAILABLE`，反复读取任务不能为该进程补开调试端口。已有安装可用 `goal-progress upgrade --json` 无重启更新 Helper；返回的 `connectionRebuildPending` 表示软件已更新、顶部显示仍待恢复，不能据此宣称界面验收通过。

界面跟随宿主浅色/深色主题，使用轻磨砂、细边框和短暂展开动效，并尊重系统减少动效设置。支持键盘、Esc 和关闭后的焦点返回；内容内部滚动，短窗口采用视口内布局。面板始终停靠居中，不支持拖动或横向滚动；旧版浮动偏好会被忽略。节点通过已记录状态与证据表达进度，不虚构任意百分比。现有工具输入、存储格式和来源权威行为保持兼容，`get` 输出可带有可选的 `heartbeatPending` 状态。

面板自动定位当前项目的 Heartbeat（若可用），点击心跳圆钮后查看来源路径、状态、审计详情和只读说明，不要求用户选择台账。项目 Heartbeat 展示与聊天任务权威分开：只有与当前任务关联的结构化 Kit 记录才会成为 `taskSource` 并替代聊天清单；无关的项目台账不会覆盖本地任务进度。若已有普通任务历史有效、没有已保存绑定且当前候选扫描结果为零，即使发现扫描不完整，也继续显示本地清单。新聊天没有任务事件时，在扫描完整前保持 pending；已知绑定（包括失效绑定）不会触发回退，多个关联候选则保持待选。`get` 在关联任务来源校验完成后返回，项目 Heartbeat 展示在后台加载；项目摘要按配置范围复用 30 秒缓存，同一项目复用进行中的读取。来源代次变化会启动刷新而不等待旧请求，展示每两秒轮询；关联来源 watcher 只失效该来源缓存。历史与心跳继续读取各自真实来源并支持分页。Heartbeat 摘要保持简短，完整诊断放在有界、可折叠的详情区。读取不创建定时器、不修改台账，也不把插件在线当成巡检。

完整开发和接口说明见 [README](README.md)，本地构建安装流程见 [INSTALL-FOR-AI](INSTALL-FOR-AI.md)。私有衍生版应从本仓库构建，不使用原作者的发布包。首次启用本地调试连接可能需要重启 Codex，必须先征得用户同意。

浏览器模拟环境验证与实际 Codex 中的验收必须分别报告。进度语义更新依赖当前模型在任务里调用插件工具；进度条不会根据时间、Token 或命令数量自动猜测完成率。

调试连接已建立后，可构建新版并运行 `./install.sh` 热更新后台与面板，无需重启 Codex。新增 MCP 工具需要重新打开受影响的聊天加载。大型心跳台账采用摘要与分页，不一次传输全部历史。

完成口径：面板只统计已登记清单，不声称知道整个任务的剩余范围。执行状态独立观察；清单勾满但仍在执行、等待或状态未知时，不显示100%或满格进度条。空闲也不代表整体交付完成。模型仍需及时登记新增和收尾工作。

普通任务记录使用可信聊天 cwd 对应的 `.workspace/codex-task-progress/`。Kit 按聊天将完整任务事件、Heartbeat 来源绑定和迁移标记写入 `tasks/v3/<thread-sha256>/taskhistory.md`，`heartbeat.md` 是最新状态的可读投影。可重建读取缓存放在工作区 `.tmp/codex-task-progress/<thread-sha256>/`，删除缓存不会丢失任务历史或来源关系。

项目 Heartbeat 台账在完成 writer-owned 切换后以当前头部 `heartbeat.md` 加同目录 `taskhistory.md` 保存完整 wake 历史；自定义头部例如 `release.md` 使用 `release.taskhistory.md`。插件通过 Kit 只读 API 展示和校验，绝不会因 UI 展示或普通读取自动迁移仍在使用中的旧单文件台账；`readProjectHeartbeat` 的兼容参数 `migrate` 也不会执行迁移。未明确 quiesce 并由 writer 接管之前，旧台账继续保持单文件，wake 的来源行指向原始文件。只有负责写入的 owner 在显式取得所有权后，才能调用 Kit 的锁定、版本检查切换 API；并发追加或冲突必须 fail closed，原始文件与副本均保留。

显式切换前，writer 先读取当前版本，再传入 ownership assertion 和刚读取的 hash：`migrateHeartbeatLedgerPair({ root, path, legacyWritersQuiescent: true, expectedContentHash: observed.contentHash })`。`legacyWritersQuiescent` 是调用方断言，要求整个操作期间所有直接写旧文件的 writer 都已停止；Kit 跨进程锁只协调 Kit writers。如果 history-first 写入中断，用 `readHeartbeatLedgerPairVersion` 读取原始版本，再将 hash 和相同 assertion 传给 `recoverHeartbeatLedgerPair`。恢复过程会校验备份和旧/计划 head，不能手工修复半成品文件。

Helper 自有的普通任务历史、来源关系及旧 workspace 路由兼容迁移仍可在首次访问时完成，因为 Helper 拥有这些记录。旧 `events.jsonl`、快照、绑定 JSON 和 `workspace-storage-index.json` 迁移后保留为备份。Kit 将跨 cwd 查找所需的持久路由记录在 Helper app root 的 `task-routing/`；它不是缓存。工作目录变化保留任务历史，但不会复制旧项目的 Heartbeat 来源绑定。后台程序、通信文件和日志仍位于系统目录。
