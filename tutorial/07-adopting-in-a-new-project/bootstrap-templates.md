# Bootstrap Templates

本文件是可以直接复制粘贴去新项目用的初始文件模板。以下字段本身是从 Nova 项目摸索出来的通用
规范,不含任何品牌/业务信息,可以直接照抄;正文示例用的是虚构的通用场景,不涉及 Nova 的具体
业务。放在阶段 2(知识产物骨架)时使用,配合 [`README.md`](./README.md) 一起看。

---

## 1. `.vibe-coding/memory/README.md`

```markdown
# Memory 系统说明

memory 记录的是**经验判断**——"上次在这里踩过什么坑、得出了什么结论、下次该怎么避开"。
它和 history(见 `.vibe-coding/history/README.md`)的本质区别是:memory 会被**原地编辑更新**,
history 只**新开一条、永远不回改**。

## Frontmatter 契约

每条 memory 文件必须以下面这段 frontmatter 开头:

\```yaml
---
name: <必须等于文件名(不含扩展名)>
description: '写这条是为了纠正哪个"会想错的瞬间"——不是"这条讲了什么"'
type: project                                          # project | feedback
status: active                                         # active | superseded
canonical_source:                                      # project 类型必填;feedback 类型填 'self'
  - '指向真源文档的路径#锚点'
related_files: []
redaction: none                                        # none | redacted | safe-placeholders
updated: 'YYYY-MM-DD'
---
\```

字段说明:

- `name`——必须和文件名(去掉 `.md` 后缀)完全一致,方便脚本按文件名反查、按 name 生成引用。
- `description`——**不要写"这篇讲了 X"**,要写"读的人如果没有这条,会在什么场景下想错、
  做错"。这是判断这条 memory 该不该被检索到的核心依据。
- `type`——`project` 表示这是从项目代码/架构本身归纳出的经验判断;`feedback` 表示这是记录
  "开发者当场纠正了 AI 的某个判断"这类反馈。`project` 类型必须填 `canonical_source` 指向权威
  出处(比如某份 doc 的具体章节);`feedback` 类型的 `canonical_source` 直接填字符串 `self`,
  因为反馈事件本身就是权威来源,没有更上游的文档可以指。
- `status`——`active` 表示仍然成立;条目过时之后改成 `superseded`,**不要直接删除文件**——
  删除会让后来者在类似场景下重复踩同一个坑,保留 `superseded` 状态并说明被什么取代,是留给
  后人的路标。
- `redaction`——这条内容里有没有需要脱敏的信息:`none` 表示完全没有敏感信息;`redacted` 表示
  已经把敏感字段替换成占位符;`safe-placeholders` 表示原文示例本身就是用虚构占位符写的,不存在
  脱敏前后的差异。
- `updated`——最后一次实质性编辑的日期,不是创建日期。

## 正文写作规范

正文遵循「证据 → 结论 → 指针」的结构:

1. **证据**——具体发生了什么(一段真实报错、一次具体的判断失误、一处具体的代码位置)。
2. **结论**——从这个证据里应该得出的通用判断。
3. **指针**——这个结论具体应该怎么用,落到哪个动作上。

正文结尾**必须**有一个 `How to apply:` 小节,写清楚"下次遇到类似场景,应该做什么"——这是
memory 和普通笔记的区别:memory 是给未来的 AI 会话直接执行用的,不是写给人读的散文。

可以用 `[[wikilink]]` 语法互相引用同目录下的其它 memory 条目,方便建立经验之间的关联,但不要
引用不存在的文件。

## 目录组织

从最小骨架开始,不需要一开始就按业务领域切分子目录。等条目数量多到需要分类时,再按项目自己的
业务边界(参考 06 号模块的服务边界框架)划出子目录,不要在项目早期臆造分类结构。
```

---

## 2. `.vibe-coding/history/README.md`

```markdown
# History 系统说明

history 记录的是**事件**——"什么时候做了什么、为什么做、怎么验证的、后续还有什么要跟进"。
它和 memory 的本质区别是:**history 永远新开一条,不要往回改旧记录**。如果某个历史决策后来
被推翻了,新开一条记录推翻这件事本身,并在新记录里通过 `related_files` 或正文指回旧记录,而
不是直接编辑旧记录——事件本身已经发生,篡改历史记录会让後来者无法理解"当时为什么会那样做"。

## Frontmatter 契约

\```yaml
---
title: '简短标题'
date: 'YYYY-MM-DD'
author: '写这条的是谁(AI 工具名或人名)'
purpose: '为什么要写这条'
category: 'architecture | workflow | release | operations | security | data | ui | ai-collaboration | other'
scope:
  - '仓库路径或领域'
status: 'active | superseded | archived'
related_files:
  - '仓库内路径(必须真实存在)'
redaction: 'none | redacted | safe-placeholders'
---
\```

字段说明:

- `title` / `date` / `author` / `purpose`——事件的基本身份信息,`author` 写清楚是哪个 AI
  工具(比如某个具体的模型/会话)还是人类。
- `category`——按事件性质分类,方便后续按类别检索;类别集合可以按项目需要扩展,但要保持
  枚举值稳定,不要每条记录发明一个新词。
- `scope`——这件事影响的仓库路径或业务领域,列表形式,可以有多个。
- `status`——`active` 表示这次事件的结论目前仍然有效;`superseded` 表示已经被更新的事件取代
  (要在正文或 `related_files` 里指向取代它的那条);`archived` 表示这件事已经不再相关(比如
  对应的功能已经下线),但仍然保留作为历史存档。
- `related_files`——列出这次事件实际改动或强相关的仓库内路径,**路径必须真实存在**,不要写
  占位符或已删除的路径。
- `redaction`——同 memory 的定义:这条记录里有没有脱敏,脱敏到什么程度。

## 正文固定四段式

\```markdown
## Summary
一两句话说清楚这次事件是什么。

## Changed
具体改了什么——文件、配置、流程、决策,尽量具体到可以按图索骥。

## Verification
怎么验证这次改动是对的——跑了什么测试、看了什么日志、做了什么人工检查。

## Follow-up
还有什么没做完、需要谁在什么条件下跟进。没有就明确写"无"。
\```

四段都要写,即使某一段内容很短。`Verification` 段尤其不能省略——一条没有验证方式的 history
记录,后来者没法判断这个结论现在是不是还站得住。
```

---

## 3. 示例 memory 条目

文件名:`.vibe-coding/memory/example-shared-cache-invalidation.md`(虚构场景,展示格式)

```markdown
---
name: example-shared-cache-invalidation
description: '写这条是为了纠正"改了共享缓存的 key 命名规则以为只影响新写入"这个会想错的瞬间——实际上旧 key 会一直命中不到,悄悄穿透到数据源'
type: project
status: active
canonical_source:
  - 'doc/caching-strategy.md#key-naming'
related_files:
  - 'packages/shared-cache/src/key-builder.ts'
redaction: none
updated: '2026-08-12'
---

## 证据

在某次重构里,把共享缓存层的 key 命名规则从 `resource:{id}` 改成了
`resource:v2:{id}`,只改了 key-builder 的代码,以为这只是"下次写入时用新格式"。
实际效果是:线上已经写入的旧 key 全部失效(读的时候永远命中不到新格式的 key),
相当于让缓存瞬间清空,所有请求同时穿透到数据源,造成了短时的负载尖峰。

## 结论

**缓存 key 命名规则不是纯代码改动,是一次隐式的数据迁移。** 任何改变 key 格式
(不只是加前缀,包括改哈希算法、改字段拼接顺序)的改动,效果等价于让所有旧缓存
一次性失效,必须按"缓存预热/灰度切换"的节奏来做,而不是当作普通代码改动直接
发布。

## How to apply:

1. 改动共享缓存 key 命名规则之前,先确认这次改动的影响范围——是不是真的需要
   改格式,还是可以用版本号字段代替(在同一个 key 下存新旧两种值)。
2. 如果确实要改格式,先做灰度/预热(比如先双写新旧两种 key 一段时间),不要
   直接切换。
3. 上线时机避开流量高峰,并提前和相关方同步"这次发布等价于清空缓存"。

参见 [[example-config-hot-reload-pitfall]](同目录下另一条相关经验,若不存在可不引用)。
```

---

## 4. 示例 history 条目

文件名:`.vibe-coding/history/2026-08-12-example-shared-cache-key-migration.md`(虚构场景)

```markdown
---
title: '共享缓存 key 命名规则升级到 v2'
date: '2026-08-12'
author: 'Claude (Sonnet)'
purpose: '修复 v1 key 命名规则里哈希碰撞概率偏高的问题,升级到带版本号的 v2 命名规则'
category: 'architecture'
scope:
  - 'packages/shared-cache'
status: 'active'
related_files:
  - 'packages/shared-cache/src/key-builder.ts'
  - 'packages/shared-cache/src/key-builder.test.ts'
  - 'doc/caching-strategy.md'
redaction: 'none'
---

## Summary

把共享缓存层的 key 命名规则从 `resource:{id}` 升级为 `resource:v2:{id}`,解决
v1 规则在高基数场景下的哈希碰撞概率问题;发布时采用双写灰度,避免缓存瞬间清空
造成的负载尖峰(踩坑经过见对应 memory 条目)。

## Changed

- `packages/shared-cache/src/key-builder.ts`:新增 `buildKeyV2()`,保留
  `buildKeyV1()` 用于灰度期间双写。
- `doc/caching-strategy.md`:新增 `#key-naming` 章节,写明 v2 规则和灰度切换
  节奏。
- 部署配置新增一个开关,控制读路径先查 v2 key、查不到再回退查 v1 key。

## Verification

- 新增单元测试覆盖 v1/v2 key 生成的差异用例(`key-builder.test.ts`)。
- 灰度期间观察 24 小时缓存命中率曲线,确认没有出现命中率骤降。
- 灰度结束后人工检查线上 key 分布,确认 v1 key 已经自然过期,v2 key 命中率
  恢复到正常水平。

## Follow-up

灰度开关和双写代码路径计划在下一次小版本发布时清理(v1 key 全部过期之后),
届时新开一条 history 记录清理动作,不在本条基础上编辑。
```

---

## 5. 空的 `MEMORY.md` / `CATALOG.md` 骨架

`MEMORY.md`(汇总所有 memory 条目的生成产物)和 `CATALOG.md`(汇总所有 skill/history 的生成
产物,具体命名可按项目习惯调整)都属于「生成投影」——**唯一真源是各条目自己的 frontmatter +
正文,`MEMORY.md`/`CATALOG.md` 是脚本从真源汇总生成出来的索引,不需要手写内容。**

初始搭建时,先建空文件占位,标注清楚它是生成产物:

`.vibe-coding/memory/MEMORY.md`:

```markdown
<!-- 本文件由脚本自动生成,不要手动编辑。真源是本目录下各条 memory 文件的 frontmatter + 正文。
     运行生成脚本后本文件会被整体覆盖。 -->
```

`.vibe-coding/CATALOG.md`(或按项目习惯放在合适的位置):

```markdown
<!-- 本文件由脚本自动生成,不要手动编辑。真源是 skills/、memory/、history/ 下各条目的
     frontmatter。运行生成脚本后本文件会被整体覆盖。 -->
```

### 生成脚本的步骤说明(伪代码,不含具体实现)

具体实现要依赖新项目自己的工具链(Node.js、Python 或别的脚本环境都可以),这里只给步骤:

```
1. 扫描目标目录(memory/ 或 skills/+history/)下所有 .md 文件
2. 对每个文件:
   a. 解析 frontmatter(YAML)
   b. 校验必填字段是否齐全、枚举字段(status/type/redaction/category)取值是否合法
   c. 校验 name 字段(如果有)是否等于文件名
   d. 校验 canonical_source / related_files 指向的路径是否真实存在
   e. 如果任何一条校验失败,整个生成过程失败并报出具体是哪个文件、哪个字段的问题
      (不要静默跳过,失败要 fail-closed)
3. 校验全部通过后,按某种排序规则(比如按 category 分组、按 updated/date 倒序)
   把每个文件的 name/title + description/purpose + 相对路径拼成一份索引
4. 把索引整体写入 MEMORY.md / CATALOG.md,覆盖旧内容
5. 把这个脚本接入 CI 或 pre-commit 检查:如果有人手改了生成产物、或者新增/修改了
   条目但没有重新生成索引,门禁应该能检测到差异并报错
```

关键原则:**生成脚本本身必须校验、必须 fail-closed**——如果一个条目的 frontmatter 缺字段
或指向了不存在的文件,生成过程应该直接失败并报错,而不是悄悄跳过这一条,否则「唯一真源 +
生成投影」这个模式就失去了保证一致性的意义。

---

## 6. `loading.md` 最小骨架

`loading.md`(或按项目习惯命名,对应 Nova 里 `CLAUDE.md`/`AGENTS.md` 承担的入口角色)是每轮
对话都会被注入的最小纪律文件。新项目可以从下面这份骨架开始,每节先写一句话占位,内容随项目
推进逐步填充,不需要一开始就写满:

```markdown
# <项目名> 项目约定

本文件每轮注入,只放"压过模型默认行为"的内容——具体怎么做某件事的操作指南放进 skill/doc,
按需加载,不占用每轮上下文。

## 指令优先级

一句话声明:项目规则和用户当轮明确指令谁优先、什么样的"默认偏好"不算不可突破的安全规则。

## 每轮必须产出可见文本

(可选,是否需要这条纪律取决于项目是否有多 agent 编排、是否需要每轮都有可追溯的进展文本。)
一句话:要求每次回复至少包含一句有信息量的可见文本,工具调用本身不算。

## 自主推进与汇报纪律

一句话说清楚:默认是自主推进到底还是遇事先问;哪几类情况必须停下来找人确认
(通常是:不可逆动作、安全边界、成本显著、需要人类做价值判断的决策),其余情况的默认动作是
什么。

## 花钱与不可逆红线速查表

一张表,每行一类"AI 自己不会想到要查、但一旦做错代价很高"的动作(比如:触发付费的云端
CI/CD、动生产环境、云测试机使用、删除数据、外部凭证轮转),写清楚红线是什么、详细规则展开在
哪个 skill/doc。

## AI 提交身份速查

一句话:AI 生成的提交应该用什么身份(名字/邮箱),和人类开发者的本地 git 身份怎么区分,防止
提交历史里身份混淆。

## Subagent 使用优先级

一句话:项目对"要不要用多 agent 并行"的默认授权态度(比如:可拆分任务默认并行,不需要每次
额外确认),具体的编排纪律指向 03 号模块对应的 skill。

## 任务完成收尾纪律

一句话:非只读任务完成后,代码/文档必须落到什么状态才算"收工"(比如:必须提交并推送到目标
分支,不能留在本地等待),具体流程指向 02 号模块对应的 skill。

## 项目事实速查

- **分支 → 环境映射**:一句话列出当前几套环境对应哪个分支/门禁线。
- **代码架构关键约定**:一句话列出服务拓扑、API 风格、后端分层这几条硬约定,详细定义指向
  06 号模块对应的 doc。

## 触发索引:做 X 之前先读 Y

一张表,列出"做某类事情之前应该先读哪个 skill",这是本文件里最容易随项目推进增长的一节——
每新增一个"AI 不读 skill 就会做错"的场景,就在这张表里加一行。
```

这份骨架里,「指令优先级」「花钱与不可逆红线」「触发索引」这三节几乎是刚性必需的——少了它们,
AI 会话缺乏最基本的边界判断依据。其余几节(每轮可见文本、汇报纪律、subagent 优先级、收尾
纪律)是否需要,取决于阶段 0 判断出的协作规模——单人单会话项目可以先不写这几节,等真的引入
多 agent 编排(阶段 5)或 worktree 隔离(阶段 3)时再补上。
