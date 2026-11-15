# Codex Task Progress

这是 [Ezra-Y/codex-goal-progress](https://github.com/ezra-y/codex-goal-progress) 的私有衍生版本，保留原 Git 历史、MIT 许可证和上游署名。0.6.0 是一次不兼容的原生专用版本：受支持界面为只读 MCP App；CDP 注入面板、自定义 Dock 启动器及其管理命令均已退役。旧版安装必须先用旧安装器安全卸载，再安装此版本。新版安装器发现旧版标记时会停止，不覆盖旧安装。

## 原生面板

原生 MCP App 使用 Codex Desktop 的 MCP Apps 入口和可选 `enable_mcp_apps` 功能。Kit 安装或复用插件与 Helper 时不会询问 Dock 入口。安装前用 `codex features list` 检查宿主功能；如果尚未启用且用户选择使用原生 MCP Apps，需显式运行 `codex features enable enable_mcp_apps`。安装器不会修改宿主设置；无法确认原生 MCP 支持或功能未启用时会返回 `NATIVE_MCP_SETUP_REQUIRED`。按 Codex 要求重新打开或新建聊天，然后在普通聊天中确认面板和数据实际可见。插件已注册、构建成功或 Helper 健康，都不能证明宿主显示了界面；不支持该功能的宿主不保证可见。

每次请求时，原生 App 解析受支持宿主的当前线程身份，再通过本机 Helper 和 Kit 规范 API 读取对应用户的任务、历史记录和项目 Heartbeat，并排除 subagent 与 ephemeral 线程。任务写入仍受 Hook 与 turn 证明保护。已有的 Codex 原生 Goal 模型 API、记录格式和兼容性继续保留；插件不创建 Goal，也不提供自定义 Goal 界面。

任务数据遵循 Kit 规范记录。原生面板展示已登记清单、记录状态与证据、分页历史，以及只读项目 Heartbeat。Heartbeat 仅用于观察，不会创建调度或写入账本。历史面板使用有界摘要投影（单次源输入最多 512 KiB，每条摘要最多 512 个 Unicode 字符），并保留完整规范 Markdown 路径；底层 Kit 记录不会被截断或改写。

## 安装与验证

请按[安装指南](INSTALL-FOR-AI.md)操作。插件要求 Apple Silicon macOS、支持 MCP Apps 的 Codex Desktop；开发与构建要求 Node.js 22.12+ 和 pnpm 11。本地发布签名复用已配置身份；签名不会授予 TCC 权限，也不会自动授权受保护目录。

分别记录包/构建检查、Helper `doctor` 与 `verify`、插件注册，以及受支持宿主中的原生 UI 可见性和数据验证。宿主功能变更后可能需要新建或重新打开聊天。不能由命令成功推断 UI 已可见。

## 数据与兼容性

本机 Helper 由现有 launchd 服务管理。MCP 请求经 stdio 服务到 Helper，再按操作权限读取或写入 Kit 规范记录。Kit 的可选 `task-progress` 类别安装或复用原生插件；不再提供单独的启动器或 Dock 选择。

现有任务和 Heartbeat 格式保持兼容。已有原生 Goal API 和 v1/v2 原始 Goal 记录仍可读取。历史源数据予以保留；简短摘要只是有界展示投影。再分发时请保留衍生版本的上游 Git 历史、许可证和署名。

参阅[架构](docs/ARCHITECTURE.md)、[权限](docs/PERMISSIONS.md)、[验证记录](docs/VALIDATION.md)和[变更日志](CHANGELOG.md)。
