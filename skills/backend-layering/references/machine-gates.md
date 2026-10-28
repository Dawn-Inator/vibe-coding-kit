# 槽位之外的机器门禁

`backend-check` 覆盖结构规则。以下规则需要项目自己实现(优先 AST/语法树,避免正则),每条都配
"存量走棘轮、陈旧即失败"(见 [backend-governance-ratchets](../../backend-governance-ratchets/SKILL.md))。

## 1. 错误语义分层

| 层 | 允许抛 | 禁止 |
| --- | --- | --- |
| 数据层(`database/`) | 数据层/领域无关异常 | 导入并抛 API 错误类型(HTTP 状态语义属于边界层) |
| 服务层 | 统一业务异常(带稳定错误码) | 裸框架 HTTP 异常(`HTTPException` / `HttpException` / `http.Error` 直写) |
| provider | 本层定义的 provider 错误类型(kind + message,不带厂商原始对象) | 抛厂商 SDK 异常或 API 错误;由上层把 provider 错误映射为业务异常 |

实现:扫描目标目录的 import 与 `raise` / `throw`,命中即 finding。Python 可用 `ast.ImportFrom` +
`ast.Raise`;TS 用 compiler API 找 `ThrowStatement` 的 `new` 表达式类型;Go 看 `errors.As` 目标与
返回的错误包类型。

## 2. 静默 except 门禁 + best-effort 作用域

宽泛捕获(`except Exception` / 裸 `except:` / `catch (e)` / 忽略 `err`)必须满足其一:**重抛**,或
**记录结构化日志**。否则一次故障会被伪装成合理默认值(例如数据库故障变成空昵称),在共享事务里
还会把外层事务毒化(PostgreSQL 在错误后拒绝同一事务内后续语句)。

合法的"降级但可见"使用统一入口:

```python
async with best_effort_scope(session, event_name="billing.nickname.degraded"):
    nickname = await load_nickname(session, uid)       # 失败: SAVEPOINT 回滚 + 结构化 warning
```

```ts
const nickname = await bestEffort(tx, "billing.nickname.degraded", () => loadNickname(tx, uid), "");
```

作用域内:触库步骤放进 savepoint;失败记带 `event.name` 与错误类型的 warning(经日志层脱敏);
`CancelledError` 等取消类异常不拦截。真正应该静默的位置(解析不可信输入、可观测性旁路本身、
缓存 fail-open)登记豁免:精确到 `path + 函数 + 序号` + 非空理由;代码改动后不再命中的豁免是
**陈旧豁免,同样失败**。

## 3. 事件循环阻塞 + 有界执行 lane

异步函数体里的同步阻塞(sleep、同步 HTTP、同步数据库连接、子进程、CPU 重计算、同步 SDK)会占住
单个事件循环,同进程所有请求一起卡住。门禁分两层:

1. **原语规则**:`async def` 体内直接调用上述原语 = finding;调用位于线程执行器实参内则放行。
2. **传递规则**:对服务源码建静态函数索引(模块函数 + 类方法,按 import / 同类 `self.m` 解析),求
   "可达阻塞原语的同步函数"的传递闭包(worklist 不动点,环安全,取最短链);`async def` 直接调用这类
   函数即命中,报告带调用链。无法静态解析的动态分派一律忽略,不猜。baseline key 用
   `规则 + 文件 + async 限定名 -> helper 限定名`,不含行号。

放行出口只有一个:**有界、命名的 lane**,禁止裸 `to_thread` / `run_in_executor` / `worker_threads`
直开(同样由门禁守,带理由的豁免)。

| lane | 用途 | 线程数取值 |
| --- | --- | --- |
| SDK | 短同步 SDK、同步 HTTP、对象存储(秒级内),默认 lane | 按 IO 并发 |
| LONG | 数秒到数十秒、无法 async 化的等待 | 独立小池,避免饿死短调用 |
| CPU | 哈希、压缩等 CPU 密集 | 按核数 |

语义:每个 lane 自己的线程池 + 排队上界;在飞 + 排队数超过 `threads + queue` 时**立即返回 503**
(过载快速 shed),不无限排队;线程里的同步调用无法被强杀,超时只释放调用方、不释放线程,所以长
等待必须用 LONG lane 而不是在 SDK lane 上加大超时;调用方上下文变量复制进工作线程。Node 对应
`worker_threads` 池 + piscina 队列上限;Go 对应带缓冲信号量 + `select default` 拒绝。

## 4. facade 不返回 ORM 行

扫描 facade 模块的公开函数返回类型,三类违规:返回 ORM 实体(含 Optional/list/dict 容器内)、
返回持有 ORM 字段的包装类(递归解析类型别名)、返回 `Any`/`object`(无法证明不泄漏)。原因:跨域
调用方拿到别域 ORM 行意味着共享 identity map、懒加载和被脏跟踪的意外写入。facade 返回冻结 DTO;
要改数据走 owner 域的显式写操作。与 `backend-check` 的"边界不泄露 ORM 类型"互补:后者看配置的
ORM 模块前缀,这里额外追踪包装类与无类型返回。

## 5. 文件体积分档

示例值(按项目调整):`>400` 行进"关注",`>500` 进"偏大",`>1000` 为红线;测试与脚本可放宽(如 800/1200/2000)。
分类按路径(service 编排入口、worker、helper、数据库槽、测试)各自设阈值。存量超限进棘轮,且
**分类规则本身要防降级**:不允许通过把文件改名/移入"测试"类目来逃脱更严阈值——对"路径降级"做
相关性检查。

## 6. N+1 查询预算

静态门禁只校验预算文件形状:每个热点接口都有预算条目;`row_invariant` 类直接锁定查询数(1 行与
N 行相同),`batch_linear` 类必须声明固定查询数 + 每项查询数 + 批量上限且算术自洽;已测试条目必须
指向真实存在的用例,未测试条目必须有非空理由。运行时用例在真库上计数 SQL 并断言不超预算。预算数
字只降不升(棘轮第 8 条)。

## 7. 跨服务复用治理工具

两个独立工程(各自虚拟环境、同名顶层包)无法互相 import 时,允许第二份实现,但必须对**同一个不
可变真源**校验:用 AST 读对方源码里的常量字面量(词表、正则、方法白名单)逐项比对,上游改而本侧未
跟上就立即变红。不要让两份可变副本互相校验。
