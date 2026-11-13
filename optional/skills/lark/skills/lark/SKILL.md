---
name: lark
description: 飞书 / Lark 能力入口：云文档、Wiki、多维表格、电子表格、消息与群聊、日历、视频会议、妙记、邮件、审批、任务、OKR、考勤、云盘、画板、幻灯片、通讯录和事件订阅。先读取本入口，再按需选择一个或多个 lark-xxx 子 skill。
---

# Lark skills

本集合包含 28 个 `lark-*` skills。子 skill 及其参考资料都位于 `../<skill-id>/`。请按当前任务读取最相关的入口和参考文件，不要一次性加载整个集合。

## 使用流程

1. 如果 `lark-cli` 尚未安装或未配置，先读取 [`lark-cli-install`](../lark-cli-install/SKILL.md)。
2. 在调用 `lark-cli` 前读取 [`lark-shared`](../lark-shared/SKILL.md)，了解该工具的身份、登录状态和权限语义。
3. 从下面的索引选择最贴近的子 skill，再按它的指引读取所需的 `references/` 文件。
4. 跨越多个能力域的任务，按需依次读取相关 skills。

## Skills

- 审批：[`lark-approval`](../lark-approval/SKILL.md)
- 应用与妙搭：[`lark-apps`](../lark-apps/SKILL.md)
- 考勤：[`lark-attendance`](../lark-attendance/SKILL.md)
- 多维表格：[`lark-base`](../lark-base/SKILL.md)
- 日历：[`lark-calendar`](../lark-calendar/SKILL.md)
- CLI 安装：[`lark-cli-install`](../lark-cli-install/SKILL.md)
- 通讯录：[`lark-contact`](../lark-contact/SKILL.md)
- 文档与 Wiki：[`lark-doc`](../lark-doc/SKILL.md)
- 云盘：[`lark-drive`](../lark-drive/SKILL.md)
- 事件订阅：[`lark-event`](../lark-event/SKILL.md)
- 消息与群聊：[`lark-im`](../lark-im/SKILL.md)
- 邮箱：[`lark-mail`](../lark-mail/SKILL.md)
- Markdown：[`lark-markdown`](../lark-markdown/SKILL.md)
- 会议纪要：[`lark-minutes`](../lark-minutes/SKILL.md)
- 笔记：[`lark-note`](../lark-note/SKILL.md)
- OKR：[`lark-okr`](../lark-okr/SKILL.md)
- OpenAPI 浏览：[`lark-openapi-explorer`](../lark-openapi-explorer/SKILL.md)
- 通用 CLI 说明：[`lark-shared`](../lark-shared/SKILL.md)
- 电子表格：[`lark-sheets`](../lark-sheets/SKILL.md)
- Skill 制作：[`lark-skill-maker`](../lark-skill-maker/SKILL.md)
- 幻灯片：[`lark-slides`](../lark-slides/SKILL.md)
- 任务：[`lark-task`](../lark-task/SKILL.md)
- 视频会议：[`lark-vc`](../lark-vc/SKILL.md)
- 视频会议代理：[`lark-vc-agent`](../lark-vc-agent/SKILL.md)
- 画板：[`lark-whiteboard`](../lark-whiteboard/SKILL.md)
- Wiki：[`lark-wiki`](../lark-wiki/SKILL.md)
- 会议摘要工作流：[`lark-workflow-meeting-summary`](../lark-workflow-meeting-summary/SKILL.md)
- 站会报告工作流：[`lark-workflow-standup-report`](../lark-workflow-standup-report/SKILL.md)

## 通用反馈跟踪工作流

[`feishu-bugfix-workflow`](../feishu-bugfix-workflow/SKILL.md) 为可选通用工作流，适用于从用户指定的共享缺陷或反馈文档接收任务并按该文档规则管理状态。它不假设任何特定产品的状态名称、表结构或写回权限。
