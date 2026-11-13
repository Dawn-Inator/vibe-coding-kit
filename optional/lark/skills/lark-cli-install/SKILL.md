---
name: lark-cli-install
description: "lark-cli 缺失/未配置/未授权时用：`command not found: lark-cli`、token 过期、新机器、'安装飞书 CLI'。已装好的日常鉴权问题走 lark-shared。"
---

# 飞书 CLI 安装与授权

官方安装文档是唯一正文真源，每次执行前先读，不要凭本页记忆代替它：
<https://open.feishu.cn/document/no_class/mcp-archive/feishu-cli-installation-guide.md>

本页只保存流程骨架和停止条件；安装细节以官方文档为准。

## 何时触发

出现以下任一信号就走本流程：

- `command not found: lark-cli`
- `lark-cli auth status` 返回 `"subtype": "not_configured"`
- `tokenStatus` 非 `valid`，或 `identities.user` / `identities.bot` 不是 `ready`
- 任何 `lark-*` skill 因为 CLI 缺失而无法执行

## 前置条件

- Node.js（提供 `npm` / `npx`）
- 仅从源码构建时才需要 Go v1.23+ 与 Python 3

## 执行顺序

1. **装 CLI**：`npm install -g @larksuite/cli`，用 `lark-cli --version` 确认。
2. **配置应用**：`lark-cli config init --new`。该命令**会阻塞并输出二维码和配置链接**，必须放到后台跑再读取输出，否则会话会挂死。把链接交给开发者本人打开。
3. **用户授权**：`lark-cli auth login --recommend`，同样阻塞，同样取出链接交给开发者。
4. **验证**：`lark-cli auth status`，确认 `identities.user.status` 与 `identities.bot.status` 均为 `ready` 且 `tokenStatus: valid`。

## 停止条件

- **不要代替开发者完成浏览器里的授权动作**，也不要代填任何凭据。第 2、3 步只负责把链接原样交出去，然后等待。
- 授权后拿到的 token 可读写对方的飞书文档、邮件和群聊。开发者说要撤销时用 `lark-cli auth logout`；开放平台后台的自建应用删除不再要求开发者本人手动操作，AI 可以代为执行——优先用飞书开放平台管理 API，需要走控制台网页操作时用应用内隔离浏览器完成，不使用开发者的真实 Chrome。
- 授权失败或 scope 不足时转 [lark-shared](../lark-shared/SKILL.md)，不要在本流程里反复重试登录。

## Managed skill repositories

Before using an installer, confirm the intended skill root and follow that host repository's source and mirror rules. Do not create links or generated mirrors manually; install to a user-selected skills directory when the repository has no vendor workflow.

## 验证

运行 `lark-cli auth status` 确认 CLI 的身份与 token 状态。若将 skill 导入由镜像或打包机制管理的仓库，再使用该仓库提供的校验命令。
