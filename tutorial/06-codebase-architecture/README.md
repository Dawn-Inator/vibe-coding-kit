# 06 · 代码架构从 0 到 1

这个模块讲的是「怎么把一个 monorepo 项目的物理结构、服务边界、后端分层、API 契约、
schema 治理这五件事想清楚」。它跟教程里其它模块不一样的地方在于:允许更多篇幅去讲清楚
Nova(化名,指代本教程参照的真实项目)具体是怎么做出这些决策的——拒绝了哪些替代方案、
用了什么量化门槛、真实踩过什么坑。

**这不是在教你抄 Nova 的目录名或者服务拓扑**。Nova 最终落地成什么样子,是它自己的业务、
团队规模、合规要求推出来的具体答案,换一个项目大概率是不同的答案。这个模块真正想传递的,
是 Nova 用来**得出**那些答案的推理框架——五层术语分离、物化门、触发条件分类、最小充分隔离
顺序、DB ledger 权威源头——这些框架本身是通用的,可以直接搬到任何新项目里,让你在自己的
业务上重新跑一遍,得出自己的答案。

每篇文件都会用加粗标注区分:**通用可复用的决策框架/机制**(照搬)vs **Nova 基于自己业务的
具体选择**(仅作为「这套框架用起来是什么样子」的例证,新项目需要重新走一遍框架、自己得出结论)。

## 开篇框架:五层术语分离

在讨论"服务边界该怎么划"之前,必须先把一件事讲清楚——因为几乎所有关于"要不要拆服务"的
争论,根子上都是这五个层次被混为一谈导致的:

| 层次 | 回答的问题 |
| --- | --- |
| **限界上下文**(bounded context) | 这是一个独立的业务概念边界吗?谁是它的权威所有者? |
| **代码 / 包边界** | 这段逻辑放在哪个目录、哪个包里? |
| **进程边界** | 这段逻辑跑在哪个进程里、由哪个入口启动? |
| **部署 / 物理机边界** | 这个进程被部署在哪台机器 / 哪个容器 / 哪个运行时环境里? |
| **数据库 / 存储边界** | 这份数据落在哪个数据库实例、哪个 schema 里? |

这五层**允许暂时不对齐**——多个限界上下文完全可以暂时共享同一个进程、同一台机器、
同一个数据库,这只是当前的物理实现选择,不代表业务判断。真正的纪律在于两个方向都不能
反推:

- **"当前物理上放在一起" ≠ "业务上是同一个系统"**——不能因为两个模块现在挤在同一个进程里,
  就认为它们的所有权、失败域、变更节奏也应该被绑在一起对待。
- **"业务概念 / 代码目录 / 表的数量多" ≠ "应该拆成对应数量的独立服务 / 容器 / 数据库"**——
  不能仅仅因为业务概念看起来足够多、代码目录足够大,就认为它理所当然需要独立部署。

这两个方向的错误推理,分别对应实践中最常见的两种反模式:**过度拆分**(看到概念多就想拆,
微服务化本身变成目的)和**拆分不足**(觉得反正部署方便就一直堆在一起,直到某个可选功能的
故障真的拖垮了核心路径)。这个五层框架会在整个模块里反复被引用,尤其是
[service-boundary-decision.md](./service-boundary-decision.md)——它讲的物化门(M0-M4)
本质上就是"这五层什么时候应该从对齐走向分离"的判断标准。

## 根目录即所有权边界

monorepo 的根目录本身也是一种架构决策的产物,不是随手建文件夹的结果。
[monorepo-layout.md](./monorepo-layout.md) 会讲清楚"给每个顶层目录一句话职责声明 +
用机器校验脚本强制"这套通用机制,以及 Nova 具体划出的顶层目录边界作为例证。

## 本模块导航

| 文件 | 内容 | 对应的 starter kit skill |
| --- | --- | --- |
| [monorepo-layout.md](./monorepo-layout.md) | 根目录结构设计原则、Nova 顶层目录表、机器校验根目录分类、云资源命名规则、环境名/分支名/产物 channel 名三角映射、目录迁移无回退表 | [`repository-layout`](../../skills/repository-layout/SKILL.md) |
| [service-boundary-decision.md](./service-boundary-decision.md) | Business/Service Materialization Card、M0-M4 物化门、hard/strong 触发条件、最小充分隔离顺序、防过拆/防欠拆清单 | [`business-boundary-cards`](../../skills/business-boundary-cards/SKILL.md)、[`data-architecture-card`](../../skills/data-architecture-card/SKILL.md) |
| [backend-layering.md](./backend-layering.md) | 后端服务内部读写分层(operate/query/projection/assembler/facade/service)、自动化门禁怎么靠这套分层实现 | [`backend-layering`](../../skills/backend-layering/SKILL.md) |
| [api-contract-convention.md](./api-contract-convention.md) | RPC over HTTP 设计取舍、URL 与代码包一一对应、GET/POST only、OpenAPI 生成纪律、一次真实改名案例 | [`api-contract-change`](../../skills/api-contract-change/SKILL.md) |
| [schema-migration-governance.md](./schema-migration-governance.md) | Data Architecture Card 触发条件、version migration 目录结构、可逆性 header 契约、DB ledger 权威源头原则、回滚优先级 | [`migration-downpath`](../../skills/migration-downpath/SKILL.md) |
| [mobile-native-build-pipeline.md](./mobile-native-build-pipeline.md) | 原生打包 wrapper 命令、必答的环境/区域两个问题、文件名/发布目录/远程存储 key 三层命名分离、"打包即发布"默认行为 | [`mobile-app-build`](../../skills/mobile-app-build/SKILL.md) |
| [ui-locale-boundary.md](./ui-locale-boundary.md) | UI locale 轴 vs 内容语言轴、每个 runtime 一份真源、keyed record 类型护栏、跨包编译期断言、locale 与外部契约 URL、错误消息 fallback 安全边界 | [`ui-locale-boundary`](../../skills/ui-locale-boundary/SKILL.md) |
| [cross-service-event-contract.md](./cross-service-event-contract.md) | 双向读源码的 allowlist 一致性测试、去重轴选择、跨服务宽度契约、新事件类型接线清单、失败分类、分层幂等 | [`cross-service-event-contract`](../../skills/cross-service-event-contract/SKILL.md) |
| [backend-guardrails.md](./backend-guardrails.md) | 可移植的后端结构检查器(Python/TypeScript/Go)、配置字段、能力边界 | [`backend-layering`](../../skills/backend-layering/SKILL.md) |
| [governance-ratchets.md](./governance-ratchets.md) | 存量债务基线只减不增、从 merge-base 读基线、过期日、防扫描塌缩假绿 | [`backend-governance-ratchets`](../../skills/backend-governance-ratchets/SKILL.md) |
| [api-idempotency-and-compat.md](./api-idempotency-and-compat.md) | 幂等键三件套、同键异 payload 为何是 409、强制升级与灰度、URL 与代码包耦合的代价 | [`api-contract-change`](../../skills/api-contract-change/SKILL.md)、[`provider-gateway`](../../skills/provider-gateway/SKILL.md) |
| [migration-online-safety.md](./migration-online-safety.md) | 锁超时与并发建索引、expand/contract 与旧版本兼容、未声明部署阶段的事故、never-dead-letter 不等于平坦重试 | [`migration-downpath`](../../skills/migration-downpath/SKILL.md)、[`test-database-isolation`](../../skills/test-database-isolation/SKILL.md)、[`data-erasure-boundary`](../../skills/data-erasure-boundary/SKILL.md) |
| [frontend-contracts.md](./frontend-contracts.md) | 框架无关的前端契约:唯一 API 客户端、幂等键、错误展示边界、平台 SDK 收口、深链白名单、埋点脱敏,附 React / uniapp 对照表 | [`frontend-api-client-contract`](../../skills/frontend-api-client-contract/SKILL.md)、[`frontend-error-display-boundary`](../../skills/frontend-error-display-boundary/SKILL.md)、[`frontend-layering-boundaries`](../../skills/frontend-layering-boundaries/SKILL.md)、[`client-routing-and-deeplink`](../../skills/client-routing-and-deeplink/SKILL.md)、[`client-telemetry-contract`](../../skills/client-telemetry-contract/SKILL.md) |

这个模块讲的是"为什么这样决策"(带 Nova 案例);右边一列链接的是同一套框架去品牌化之后、
可以直接拖进新项目使用的可执行版本——两者内容互相印证,教程负责讲道理,skill 负责能照着做。
