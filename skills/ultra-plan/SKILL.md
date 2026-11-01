---
name: ultra-plan
description: Use only when the developer explicitly asks for a large-scale, multi-document plan (e.g. "/ultra-plan" or "用 ultra-plan"). Do not trigger from task size, module count, architecture scope, cross-stack work, or phrases like "整套/全套/整个系统/大型架构"; normal-plan remains the default unless this is named explicitly.
---

# ultra-plan:大型需求多文档拆解

## 触发边界

[normal-plan](../normal-plan/SKILL.md) 仍然是默认的 Plan Mode 规范。只有开发者本轮明确点名
`ultra-plan` / `/ultra-plan` / "用 ultra-plan" 时,才使用本 skill。

不要因为需求很大、跨前端/后端/基础设施、模块很多、需要多个 AI session,或用户说"整套/全套/大型
架构",就自动从 `normal-plan` 升级——最多在 `normal-plan` 的产物里提一句"这个规模也许适合升级到
ultra-plan,要不要点名使用"。开发者点名后,也不要因为任务看起来较小而自己降级。

## 与派发机制的关系

`ultra-plan` 是**规划期**产物:产出一套可评审的多文档计划(总体规划 + 每个模块一份详细文档),由
人工评审、可能跨多个 AI session 执行。它本身不授予任何特殊调度权限——具体怎么派发 subagent、
用哪种编排机制,仍然按 [agent-orchestration-guardrails](../agent-orchestration-guardrails/SKILL.md)
的判据来选,不要因为在写"大计划"就默认切换到更激进的自动化派发模式。

**Phase 1(调研阶段)只能用会把每个 explorer 的完整报告返回给主 agent 的派发机制**——本 skill 的
主 agent 必须真的读到每一份调研报告,才能综合出总体规划和模块文档;不要在这一步用那种"结果不回传、
只能事后审查"的独立执行机制。

**什么时候可以跳过 ultra-plan**:任务是纯只读审计/研究、不需要留下可评审的计划文档时,直接按
`agent-orchestration-guardrails` 的判据派发调研 subagent 就够了,不需要走本 skill 完整的多文档
产出流程。需要"人工评审 + 留痕 + 可能跨 session 执行"的大计划才用 `ultra-plan`。

## 项目基线与产物

读取项目当前 loading、normal-plan、worktree lifecycle 与 coding-gate-preflight 的权威源；生成投影不是编辑源。
默认产物是 .workspace/plan/<yyyy-mm-dd>-<feature>-v<N>/plan/ 下的 00_总体规划.md 和各模块文档；
共享契约复杂时另写 99_跨模块契约.md。版本号取该 feature 已有计划的下一个版本。

## Hard Rules

1. 先做 Phase 0 执行模式确认,除非用户初始 prompt 已经明说"直接执行/立即执行/写完后执行/自动跑"。
2. Phase 0.1 必须先读取"项目基线读取"列出的源文件,再问 feature 名。
3. **Phase 0.5(裁决先行)必须在 Phase 1 之前跑完**:主 agent 先列出跨模块决策清单并逐项裁决、
   写下理由,才能进入调研阶段。让调研员在未裁决的开放性问题上各自设计整套方案,是这个 skill 曾
   经真实发生过的 token 浪费大头——细节见 Phase 0.5。
4. 调研是否并行由用户授权、平台和项目规则决定；只拆独立且有实际收益的单元，不设默认数量或指定模型。
5. Phase 1 的 subagent 只在 Phase 0.5 已裁决的约束下调研"现状事实 + 实现路径",不写代码、不改
   文件、**不得重开已裁决事项**(确有异议只写一段"异议",不展开替代方案)。
6. `00_总体规划.md` 必须由主 agent 串行写,不能派 subagent 代写。
7. 模块文档必须写到"执行者只读 00 + 本模块文档就能实现"的详细程度:文件路径、接口、字段、测试
   脚本、验收场景和决策默认答案都要具体,不留"按需""待定";**文件级事实引用调研报告的绝对路径
   与小节,不整段复制进模块文档**——模块文档本身只写决策、接口、文件计划、测试计划、派发指令。
8. 低耦合模块可以并行派 subagent 写文档;高耦合模块和跨模块契约由主 agent 串行写,减少术语漂移。
9. 当共享契约复杂到不适合放入总体规划时，先写 `99_跨模块契约.md`；实施依赖它的模块前固定契约。
10. Phase 4 不再二次确认执行模式,按 Phase 0 的答案分支。
11. 如果开发者已授权直接执行,Phase 5 必须从第一波连续执行到最后一波;波间只自检、更新进度、
    继续下一波,不能停下等确认;**每个 Wave 边界都要查一次额度**,阈值见项目 `loading.md` /
    `agent-orchestration-guardrails`。
12. `00_总体规划.md` 必须自带"有预算的实现后审查"计划:审查范围限定在资金/计费路径、安全边界、
    从未在真实数据库上执行过的 SQL、只有真机/真浏览器才能验证的交互这四类,并写出 token 预算——
    分级细则(自评严重度、只对 blocking/major 派独立证伪者)见 `agent-orchestration-guardrails`,
    这里不重复。
13. 如有派发，明确独立职责、路径、只读/写入边界和回传方式；遵守平台与项目约定。

## Workflow

### Phase 0:启动输入

0.0 根据用户已表达的意图确定执行模式；只有真实不明确且会改变下一步时才通过可用方式询问:
- **A:写完先停**——生成全部文档,输出清单,然后停下等评审。
- **B:直接执行**——文档生成后进入 Phase 5,连续执行全部 Wave。

已有明确授权、此前答复或用户意图足以确定时，不重复询问。

0.1 读取项目基线源文件,把当前规则的摘要(不是原文长篇复制)写进总体规划文档的"项目执行基线"
部分,附上源文件路径。

0.2 仅在无法从请求确定时确认 feature 名。输出目录固定为 `.workspace/plan/<yyyy-mm-dd>-<feature>-v<N>/plan/`。调研范围由实际独立问题和平台授权决定。

如果你的项目有 `normal-plan`,在 Phase 2 明确影响面之后、Phase 3 写总体规划之前,补齐
`normal-plan` 当前要求的目标分支和测试意向输入。测试脚本变更计划与测试运行计划要分开记录,跟
`normal-plan` 的要求一致。

### Phase 0.5:裁决先行(必须在 Phase 1 之前完成)

主 agent 先列出"跨模块决策清单"——常见项:鉴权方式、URL/命名前缀、域名与部署位置、凭证存放口径、
数据放哪个库/表、同步还是异步、通知架构……按当前任务实际的跨模块面收集,不局限于这个示例清单。

对清单里的每一项:

- 优先用项目已有的常设口径(`loading.md`、既有 skill、既有架构文档)直接定死,写下理由和依据
  文件路径。
- 项目常设口径没覆盖、且判断需要现状证据时,最多派 1-2 个"侦察型" explorer 去确认事实(只找
  事实,不设计方案),回来后由主 agent 裁决。
- 拿不准、且属于 owner 决策域(安全参数、成本、产品口径……)的,才正式问 owner;其余不确定一律
  由主 agent 依据已有证据裁决,不要留到 Phase 1 让多个调研员各自方案化。

每一项都写下"结论 + 理由 + 依据",整理进 `00_总体规划.md` 的"已裁决的跨模块决策"小节(见
模板)。**这一步没做完不进入 Phase 1**——把设计权留给调研员本身就会让同一件跨模块的事被设计出
好几个互斥版本(真实发生过的案例:同一次规划里出现了 3 种互斥的鉴权方案、2 种 URL 前缀、2 种
密码存放口径、2 种通知架构,主 agent 要读完全部方案摘要才能裁决,决策成本被放大了好几倍);调研
真正有价值的产出应该是事实和实现路径,不是重复设计。

### Phase 1:调研（在 Phase 0.5 已裁决的约束下）

根据问题独立性和平台授权决定是否派发。允许并行时，每个调研单元只返回事实、路径与证据，
不重开已裁决事项；主 agent 综合完整结果。没有派发授权时由当前 agent 调研。

### Phase 2:拆解

主 agent 综合调研报告,拆成可交付模块,标记高/中/低耦合(判断依据:模块之间是否共享事务边界、
是否有循环依赖、改动一个模块是否大概率要求同步改另一个),画依赖图并划分 Wave。

**Wave 划分双约束**:同时满足文件级写冲突(同一文件不能被两个并行 worker 同时改)和主机重进程
上限(见 `agent-orchestration-guardrails` 的重进程限流规则)——不要只按模块依赖图划 Wave 而忽略
后者,并行 Wave 里同时起几个原生构建/端到端测试/golden 回放,会把主机拖垮,反而拖慢所有人。

写总体规划前,把 `normal-plan` 当前的必填项映射成 `ultra-plan` 的全局执行闭环。不要复制
`normal-plan` 的完整规则原文;在总体规划里写明已读取的源文件、当前任务的结论、以及"无影响"项
各自的具体理由。

### Phase 3:写文档

主 agent 串行写,且**必须按这个顺序**:
1. `99_跨模块契约.md`(若共享契约复杂且需独立文件)——先写死,再写其它模块文档。契约先冻结之后,
   前后端才能据此并行开发、用 fixture 写单测,能省掉后续审查里大量"前后端联调错位"类发现。
2. `00_总体规划.md`(模板见下方)。
3. 高耦合模块文档。

低耦合模块可以并行派 subagent 写,用同一份模块文档模板(见下方)。根据依赖与写入边界决定串行还是并行。**模块文档写文件级事实时引用
调研报告的绝对路径 + 小节,不整段复制**——模块文档本身只承载决策、接口、文件计划、测试计划、
派发指令。

### Phase 4:分支处理

写完所有文档后:
1. 检查工作区改动只涉及预期的 `.workspace/plan/<yyyy-mm-dd>-<feature>-v<N>/plan/` 规划文件,没有意外碰到其它文件。
2. 输出文档清单。
3. 按 Phase 0 的执行模式分支:写完先停就停止;直接执行就进入 Phase 5。

### Phase 5:直接执行

仅在 Phase 0 选择"直接执行",或用户初始 prompt 明说直接执行时进入。按总体规划里的 Wave 推进,
Wave 内可并行,Wave 之间串行但不中断。**每个 Wave 边界查一次额度**:阈值达到项目"停止派发新
agent"档位就不再开新 Wave 的并行派发,达到"停止全部"档位就转入合并 + 接手文档 + push(阈值见
项目 `loading.md` / `agent-orchestration-guardrails`,这里不重复维护具体数字)。

进入实现前重新读一遍你项目的 `loading.md`、`normal-plan`、`agent-worktree-lifecycle`、
`coding-gate-preflight`,按当前项目规则处理 worktree、测试、文档、迁移、验证和最终报告——不要
依赖 `ultra-plan` 文档里对这些规则的旧摘要,规则本身可能已经变了。

多个 worker Wave 并行时的 worktree 收尾责任:**各 worker 各自 finish 自己的 worktree**(收尾细则
以 `normal-plan` / `agent-worktree-lifecycle` 为准,本 skill 不重复维护);**主 agent 在全部 Wave
结束后做一次最终收尾核对**,确认没有遗留未 finish 的受管 worktree,发现遗留要补 finish 或写明
阻塞原因。

## 计划模板

总体、模块和跨模块契约的示例结构见 [planning-templates.md](references/planning-templates.md)。项目约束更具体时以项目权威为准。

## 常见风险

按实际依赖与平台授权控制调研范围；不要让多个调研单元重复决策或把未裁决方案当成既定契约。
