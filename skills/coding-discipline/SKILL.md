---
name: coding-discipline
description: Use when writing or reviewing production code that adds nil/null checks, validation, error handling, recover/try-catch, readiness probes or bootstrap wiring, or when writing rules that tell agents to be strict or fail closed.
---

# 编码纪律:在边界校验一次,在内部信任

AI 写代码最常见的失败模式不是"不够小心",而是**处处小心**:每个函数入口判 nil,每个错误都换成
同一个哨兵,每个 handler 自己 `recover`,每个响应都按字段集合严格比对。单看每一处都"更安全",
合起来就是噪音淹没逻辑、错误原因丢失、协议无法演进,而且真正的 bug 照样藏在里面。

这个 skill 规定**防御放在哪里、放多少**。它和 [backend-layering](../backend-layering/SKILL.md)
(代码放在哪一层)互补;存量债务用 [backend-governance-ratchets](../backend-governance-ratchets/SKILL.md)
的棘轮冻结;机器门禁是 kit 的 `hygiene` 命令,见 [references/hygiene-gate.md](references/hygiene-gate.md)。

## 核心原则

1. **信任边界只有少数几处,校验在那里做完。** 边界是:公网/客户端入口、第三方回调与 SDK 返回、
   配置与环境变量加载、从持久化读回的历史数据、文件与消息队列等跨进程输入。过了边界,数据就是
   已验证的类型,内部代码不再重复校验。
2. **依赖在构造时校验,调用时信任。** `NewX(deps)` 检查必需依赖并返回带原因的错误;构造成功的
   对象在每个方法里都可以假定依赖存在。不要在方法里写 `if s == nil || s.db == nil`。
3. **错误要能回答"哪里、为什么"。** 包装而不是替换:`fmt.Errorf("load order %s: %w", id, err)`。
   哨兵错误只用于**调用方确实要据此分支**的情形,而且一个哨兵对应一种原因。
4. **横切关注点只写一次。** panic 恢复、调用方身份/鉴权、超时、日志、限流、指标放进拦截器或中间件,
   业务 handler 不重复。
5. **宽容读、严格写(Tolerant Reader)。** 服务内部与东西向调用忽略未知字段、容忍新增枚举值;
   只在公网入口和安全敏感结构上拒收未知字段,并写明原因。
6. **为可能发生的失败写代码,不为不可能的失败写代码。** 能在类型、构造期或启动自检里排除的情形,
   不在每次调用时再查一遍。

## 规则清单

| # | 规则 | 反模式 | 正确做法 |
| --- | --- | --- | --- |
| R1 | 构造期校验依赖 | 方法内 `if r == nil \|\| r.client == nil` | 构造函数校验一次;零值不可用时不导出零值可用的类型 |
| R2 | 不判 nil context | `if ctx == nil` | Go 约定 ctx 永不为 nil;只在长循环或昂贵调用前看 `ctx.Err()` |
| R3 | 不用反射判 typed nil | `reflect.ValueOf(x).IsNil()` | 构造时拒绝 nil 依赖;接口字段不赋 typed nil |
| R4 | 错误可区分 | `if err != nil { return ErrConfig }`,一个函数十种原因同一个错误 | `%w` 包装保留原因;需要分支的原因各用一个哨兵或错误类型 |
| R5 | recover 集中 | 每个 handler 自己 `defer recover()` | 一个 gRPC 拦截器 / HTTP 中间件恢复并记录 |
| R6 | 鉴权集中 | 每个 handler 判 `callerID != "x"` | 拦截器按方法表授权 |
| R7 | 宽容读 | 内部 RPC 检查 `GetUnknown()` 并拒收,前端要求字段集合完全一致 | 忽略未知字段;只校验自己用到的字段 |
| R8 | 不校验自己的输出 | 刚从自家 Query 拿到结果又 `Validate(result)` | 在产生数据的那一层保证不变量;只校验跨边界的外部数据 |
| R9 | 就绪探针轻量 | readiness 里发远程 RPC、逐分片查库 | 读后台刷新的内存状态;深度自检放启动或独立诊断命令 |
| R10 | 组装根要薄 | `bootstrap/` 里写 SQL、业务分支、领域适配 | 组装根只 `new` 与连线;适配器归 service/provider/adapter 层 |
| R11 | 生命周期复用 | 每个后台任务都手写一组 `mu/cancel/done/stopped` | 一个通用 Worker/Lifecycle 组件,各功能持有实例 |
| R12 | 条件可读 | 一个 `if` 串十几个 `\|\|` | 拆成具名谓词;能移到构造期的不变量移走 |
| R13 | 格式与行长 | 未格式化、单行几百字符 | 语言官方 formatter 必过;行长上限(默认 160) |
| R14 | 按行为命名 | `closure_v11_x_test.go`、注释写交付过程 | 测试名描述行为;注释写"做什么/为什么",不写"哪一轮任务加的" |

每条的多语言正反例见 [references/examples.md](references/examples.md)。

## 什么时候防御是对的

防御不是坏事,放错位置才是。下列情形**应该**写检查,并让失败可见:

- **信任边界上的输入**:按 schema 校验,错误信息具体到字段。
- **资金、权限、数据删除等不可逆路径上的业务不变量**:余额不为负、幂等键已占用、版本号匹配。
  这是业务规则,不是防御噪音,用明确的领域错误表达。
- **并发与外部状态**:乐观锁冲突、TOCTOU、外部服务超时与部分失败。
- **启动自检**:配置、证书、依赖连通性在进程启动时检查一次,失败就不启动。

判断一条检查该不该写,问三个问题:

1. 这个条件在构造或启动之后**还可能**为假吗?不可能 → 删。
2. 它为假时,调用方/运维**能看到具体原因**吗?不能 → 改成带原因的错误,或删。
3. 同样的检查是否已在边界或拦截器做过?做过 → 删。

## 给项目写规则时的措辞

AI 会把文档里的语气**推广到每一个函数**。交付文档里写"严格校验""保守失败""结果未知时返回未知",
如果不限定范围,得到的就是全仓库的 nil 检查和错误塌缩。写规则时:

- 写明**作用范围**:"公网入口拒收未知字段",而不是"严格校验未知字段"。
- 写明**失败如何可见**:"返回 `ErrStaleVersion` 并记录 operation id",而不是"fail closed"。
- 同时写出**不要做什么**:"内部调用不重复校验已由网关校验的字段"。
- 规则要配机器门禁;没有门禁的规则对 AI 等于不存在。

## 落地

1. 新项目:复制 kit 的 `templates/code-hygiene.json` 到 `.vibe-coding/code-hygiene.json`,按项目调整
   `include`、`compositionRoots`、`dataAccessImports`,零基线起步。
2. 已有项目:`hygiene write-baseline` 冻结存量,接进项目 gate;之后每次改动只许减少。
3. 评审时对照上表;门禁覆盖不到的规则(R8、R9、R11、R14)靠评审和
   [architecture-rot-audit](../architecture-rot-audit/SKILL.md) 定期盘点。

命令、规则编号、配置与豁免写法见 [references/hygiene-gate.md](references/hygiene-gate.md)。
