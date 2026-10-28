---
name: backend-layering
description: Use when adding or reviewing business-logic code inside a backend service. Governs how to split one business object's code into read/write slots so that "does this file touch the database, and how" becomes a machine-checkable fact instead of something a reviewer has to notice.
---

# Backend Layering(读写分层)

[api-contract-change](../api-contract-change/SKILL.md) 和
[business-boundary-cards](../business-boundary-cards/SKILL.md) 解决的是"服务之间的边界"——这个
skill 解决的是更细一层的问题:**一个服务内部**,单个业务对象的代码应该怎么组织,才能让"这段代码
是在读数据库还是写数据库、有没有绕过应有的边界"这件事,变成一个自动化脚本能机械核对的事实,而不是
只能靠代码评审的人恰好留意到。

下面举例用到的具体文件名(`operate.py`、`query.py` 等)是 Python 生态的命名习惯,换一种语言/框架
可以用别的文件名或目录约定,只要保留"槽位职责单一、命名规范到机器能识别"这个核心设计——这才是这套
机制真正的价值所在,具体文件名只是一种实现方式。

## 服务骨架

槽位(见下节)回答"一个对象内部怎么分";骨架回答"一个服务里目录怎么摆"。依赖**只能向下**:

```
api ──> service/<domain>/<module>/<object>/ ──> core
                 │                               ^
                 ├──> provider (ports → adapters) ┤
                 └──> database/<store>/<table>/ ──┘
bootstrap ──> 以上全部(只在装配与进程入口处)
```

| 目录 | 职责 |
| --- | --- |
| `api/` | 路由装配(把各对象的 router 挂到版本前缀下)、鉴权策略、路由清单/契约守卫 |
| `service/<domain>/<module>/<object>/` | 业务逻辑,按下节六槽位 + router/model/mixin 等辅助槽组织 |
| `core/` | **跨域中立**能力:响应外壳、异常基类、分页、outbox、幂等、阻塞隔离、内部网关客户端、日志。不含任何业务域概念 |
| `provider/` | 第三方集成:`ports`(业务侧依赖的抽象)、`composition`(按配置装配)、`adapters`(厂商 SDK 实现) |
| `database/<store>/<table>/` | 表级 `model`(ORM)+ 表级通用写 `operate` + 表 `facade`(对外只读/受限入口) |
| `bootstrap/` | 进程生命周期、readiness、后台 worker 入口、启动配置自检 |

不变量(每条都要有机器强制,见下文与 `backend-check`):

- `core/`、`provider/`、`database/` **禁止 import** `service/`、`api/`——否则下层依赖上层,环与隐性耦合立刻出现。
- 跨 domain 只经对方的 **facade** 或 **contract 模块**(稳定 DTO/事件定义),不碰对方的 service/operate/query。
- **写操作两级**:对单表的通用增删改放 `database/` 的表级 `operate`;带业务规则、跨表事务的写放
  `service/` 对象目录的 `operate`。通用 CRUD 留在 service 层是"退化的写槽",应下沉。

三种语言的目录映射(Go 的包边界与导出符号代替 Python 的文件约定,完整对照见
[references/skeleton-mapping.md](references/skeleton-mapping.md)):

| 概念 | Python (FastAPI) | Node (NestJS/Express) | Go |
| --- | --- | --- | --- |
| 路由装配 | `app/api/` | `src/api/` | `internal/api/` |
| 业务对象 | `app/service/<d>/<m>/<o>/` | `src/service/<d>/<m>/<o>/` | `internal/service/<d>/<m>/<o>/`(一个 package) |
| 跨域中立 | `app/core/` | `src/core/` | `internal/core/` |
| 第三方集成 | `app/provider/` | `src/provider/` | `internal/provider/` |
| 表级数据 | `app/database/<store>/<table>/` | `src/database/<store>/<table>/` | `internal/database/<store>/<table>/` |
| 装配/进程入口 | `app/bootstrap/` | `src/bootstrap/` | `cmd/<svc>/` + `internal/bootstrap/` |

## 六个槽位

槽位是职责边界,不是每个对象都必须创建六个文件。简单能力只创建有实际职责的文件;
Go 等语言按 package 与导出 API 表达领域边界,不要照搬 Python 的文件导入约定。
接口存在也不能证明解耦:还要检查依赖环、ORM 类型和副作用是否泄漏。

一个业务对象的代码,按六个槽位分层(适用范围是每个服务自己的业务逻辑目录,比如
`<service>/<object>/`):

| 槽位 | 示例文件名 | 职责 |
| --- | --- | --- |
| 写操作槽 | `operate.py` | 这个业务对象私有的创建/更新/删除/发布/领取/退款等写操作,以及需要在一个事务里跨表写的逻辑 |
| 查询组合槽 | `query.py` | list/detail/search/query 这类读取路径,负责 where/排序/分页/游标/过滤条件的组合,返回内部记录或中间读模型 |
| 批量组装槽 | `projection.py` | 把一批内部记录批量组装成对外 DTO,**明确允许**在这里做批量聚合查询以避免 N+1 |
| 纯组装槽 | `assembler.py` | 纯粹的字段改名/默认值填充/脱敏转换,**不允许**发起额外数据库查询或持有数据库会话 |
| 门面槽 | `facade.py` | 只有当另一个顶层业务领域需要稳定读取/操作这个领域的数据时才需要,暴露稳定方法和 DTO |
| 编排入口槽 | `service.py` | 只负责应用层流程编排,**明确禁止**出现任何原始 SQL 或复杂数据库查询构造 |

## 辅助槽(六槽位之外)

| 槽位 | 示例文件名 | 说明 |
| --- | --- | --- |
| 路由 | `router.py` / `router_internal.py` | 只做参数解析、鉴权依赖、调用编排入口、套响应外壳;内部服务间接口放 `router_internal`,与公开路由使用不同鉴权 |
| DTO | `model.py` | 请求/响应 DTO,边界类型的唯一来源;不含 ORM 类型 |
| 共享编排片段 | `mixin.py` | 同一对象内多个入口共用的编排片段;**不得含 SQL**,读写仍下放到 query/operate |
| 条件构造 | `query_builder.py` | 只**构造**查询(where/排序/游标)返回可组合对象,**不执行** |
| 表专属写 | `<table>_operate.py` | 当同一对象目录下操作多张表时,表专属写槽的兼容命名;规则与 `operate` 完全相同 |

## 几条槽位之间的判断细节

- **写操作槽的退化判断**:如果写操作槽里的某段逻辑其实已经退化成"就是对某张表做通用的增删改",
  没有真正的业务编排价值,应该下沉到数据库层自己的写操作文件里,业务层这个文件只保留真正需要业务
  规则介入的写操作。
- **所有权迁移后,查询组合槽应删除,而不是改造成远程调用的包装壳。** 该槽位语义是"进程内直接查
  数据库";悄悄改成跨服务调用,门禁仍按文件名当本地查询校验,形成它自己都不知道的盲区。正确做法
  是让编排入口改调类型安全的内部网关客户端(见 [business-boundary-cards](../business-boundary-cards/SKILL.md))。
- **批量组装槽明确允许批量聚合查询**,这是它和纯组装槽的核心区别:比如给一批 feed 内容批量附加
  作者信息/点赞状态/关注状态,这种批量聚合应该放在批量组装槽里一次性做完,而不是在循环里逐条查
  (N+1)。
- **纯组装槽升级的判断标准**:纯组装槽如果开始需要拿数据库会话再去查一次数据,说明它该升级成
  批量组装槽;如果它开始组织 where/排序/分页这些查询条件,说明它该归到查询组合槽。这两条判断标准
  本身可以直接写进代码评审 checklist,不需要每次都重新讨论。
- **槽位文件不一定要放在最深层的对象目录**——因为槽位划分不驱动路由,一个共享的模块级槽位文件,
  在多个对象只是同一个模块下不同路由切片的场景里是合理的(比如几个子对象共用同一个业务编排类)。

## 为什么要这样分层:目标是自动化门禁

读写分进命名规范的文件后,就能写静态扫描:只有查询/批量组装槽出现数据库读,只有写操作槽出现数据库
写,其它文件(编排入口、共享工具、定时任务等)一旦出现原始 SQL 或会话调用即被拦下。机械扫描每次
同一标准,不依赖评审者恰好留意。

对于分层规则落地之前就已经存在的历史违规,用 [backend-governance-ratchets](../backend-governance-ratchets/SKILL.md)
的棘轮精确登记并只减不增——基线是承认历史债务,不是给新代码开口子;新项目则直接零债务。

## 跨领域导入边界

除了槽位内部的读写分层,还有一条跨领域的导入边界:**禁止跨领域直接引用另一个领域内部更深层的
编排入口文件**,只能通过对方的门面槽或者中立的公共层来交互。这条规则和
[business-boundary-cards](../business-boundary-cards/SKILL.md) 里 M1 门("跨边界的事务/JOIN 都已
改造成通过所有者暴露的查询/命令/事件/投影/编排来访问")是同一个思路在更小粒度上的延伸——即使两个
领域现在都跑在同一个进程里、还没有物理拆分的必要,也应该提前维持"只能通过稳定接口交互"的纪律,
这样将来真的需要把某个领域物化成独立服务时,迁移成本会小得多。

## 槽位之外的机器门禁

`backend-check` 只管结构(环、读写槽、ORM 泄漏、vendor SDK 位置)。下面几类需要项目自己补;每类的
判据、反例、实现要点见 [references/machine-gates.md](references/machine-gates.md)。存量债务一律用
[backend-governance-ratchets](../backend-governance-ratchets/SKILL.md) 的棘轮,新项目直接零债务。

- **错误语义分层**:数据层禁抛 API 错误类型;服务层禁抛裸框架 HTTP 异常(走统一业务异常);
  provider 只抛 provider 自己的错误类型,由上层映射。
- **静默 except 门禁**:宽泛捕获(`Exception`/裸 `except`/`catch (e)`)必须重抛或写结构化日志;豁免带理由,
  不再命中的豁免失败。"允许降级"走 best-effort 作用域(savepoint + 结构化 warning),不吞主事务。
- **事件循环阻塞**:异步函数体内的同步阻塞调用(含经传递调用图可达的 helper)必须走有界执行 lane,
  按 SDK/长任务/CPU 分 lane,满载立即 503,不无限排队。
- **facade 不返回 ORM 行**:跨域调用方拿到 ORM 行意味着共享会话状态与懒加载;facade 返回冻结 DTO。
- **文件体积分档**(示例值:400 关注 / 500 偏大 / 1000 红线,测试与脚本可放宽),超限必须拆槽位。
- **N+1 查询预算**:热点接口声明查询数上限,运行时用例实测断言,预算只降不升。
- **跨服务复用治理工具**:两个独立工程共用规则常量时,用 AST 读对方源码常量逐项比对,不维护两份可变副本。

## 怎么把这套分层做成机器可强制的门禁

Kit 已提供 Python、TypeScript、Go 的结构检查入口:

```sh
node .vibe-coding/kit/cli.mjs backend-check --project-root .
```

接入前阅读 [配置、各语言语义和能力边界](../../tutorial/06-codebase-architecture/backend-guardrails.md),
使用对应模板声明真实扫描范围,并把命令接到项目选定的 gate。缺工具链、空范围、解析失败不可报绿。
当前检查没有历史债务白名单。下述完整门禁目标仍需结合项目的 ORM、框架和集成测试实现;
不能将结构检查通过解释为所有契约均已验证。

若要补一个项目自有的扫描脚本,做这几件事:

1. 遍历每个业务逻辑目录下的文件,按文件名匹配到对应的槽位。
2. 仅查询/批量组装/写操作槽允许数据库读写;其它槽位(尤其编排入口)出现原始 SQL、ORM 查询构造或会话直接使用即违规。
3. 存量违规走棘轮基线(只减不增、带 owner/expiry、陈旧即失败),见上述 skill。
4. 检测跨领域导入——如果某个领域的代码 import 了另一个领域编排入口槽或数据库层文件的路径,判定
   为违规,提示改走对方的门面槽。
