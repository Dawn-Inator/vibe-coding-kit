# 前端契约:三类「写了规则、没有门禁」的坑

前端最容易出事的地方,不是没人知道规则,而是规则只写在文档或 code review 的口头约定里。下面三个
Nova 案例结构一样:**规则存在 → 没有机器检查 → 新代码在不知情的情况下绕过它 → 很久之后才被发现**。
解法也一样:把规则变成「新增就必须被分类、没分类就红」的 fail-closed 门禁。

## 坑一:幂等键规则写了,多处 `Math.random` 回退

Nova 的写操作(下单、提交评论、发帖)需要幂等键:同一次用户意图重试时必须带同一个键,服务端据此去重。
规则文档写得很清楚:「键在用户意图产生时生成一次,重试复用」。

实际代码里却出现了多种写法:有的在请求拦截器里每次发送都生成新键(重试即失效),有的在
`crypto.randomUUID` 不可用的环境里回退到 `Math.random().toString(36)`(碰撞概率高、且不可审计)。
这些写法分散在十几个文件里,每个单独看都「能跑」,直到弱网下出现重复下单。

**为什么规则没拦住**:规则面向「人」,而人不会在写第十三个调用点时回头读文档。

**门禁做法**:
1. 只允许一个模块生成幂等键(`createIdempotencyKey()`),且键由调用方在意图层持有并传入,请求层只透传、不生成。
2. lint/整树扫描:除该模块外,出现 `Math.random`、`Date.now()` 拼键、自造 `Idempotency-Key` 头即红。
3. 契约测试:同一意图连续重试 N 次,断言网络层看到的键相同。
4. 重放策略也进同一张表:哪些请求允许自动重试(幂等读、带键写),哪些绝不自动重放(无键写、支付确认)。

## 坑二:后端错误原文直接渲染,泄露内部信息

Nova 早期为了「省事」,请求失败时把 `error.message` 直接 toast 给用户。后端异常经层层包装后,
消息里出现过 SQL 片段、内部服务名、堆栈行号、第三方供应商的原始报错。用户看到的是乱码,
攻击者看到的是侦察信息,翻译团队则完全无法覆盖(原文是英文或中文混杂)。

**门禁做法**:
1. 后端只返回稳定的**错误码**(`auth.token_expired`、`quota.exceeded`),原文只进日志。
2. 客户端有一张「错误码 → 展示类别 → i18n key」表;展示类别决定行为(重试按钮、重新登录、联系客服、静默)。
   未知错误码落到通用兜底文案,**永远不渲染服务端 message**。
3. 整树扫描:UI 层出现 `toast(error.message)`、`{error.detail}` 之类渲染即红;错误码表的 key 必须存在于所有 locale。
4. 契约测试:构造含内部信息的后端响应,断言 DOM/视图里不出现其中任何片段。
5. 日志侧同样脱敏,参见 [`client-telemetry-contract`](../../skills/client-telemetry-contract/SKILL.md)。

文案缺失的兜底安全边界参见 [UI 语言轴 vs 内容语言轴](./ui-locale-boundary.md)。

## 坑三:深链新区域未分类,被默认放行

Nova 的 App 注册了自定义 scheme。深链处理器最后一行是「没命中改写规则就原样 push」——一个本意是
**改写**路径的函数,被当成了**校验**函数。于是每新增一个页面(包括内部调试页、支付中间步骤),它自动变成
可被任意网页 `<a href="nova://...">` 直达的入口。没有人做过这个决定,它只是「默认如此」。

**门禁做法**:
1. 深链入口改为显式清单 + 默认拒绝,区域分三类:允许 / 需登录 / 禁止。
2. 测试扫描真实路由目录(或 uniapp 的 `pages.json`),每个一级区域必须落在清单之一;新增未分类即红,
   清单里的死条目也红。
3. 站内跳转目标统一走 `isSafeInternalPath`;多个包里有副本时用 parity 测试保持一致。
4. 「哪些路由需要登录」由脚本解析路由与守卫得出契约表,漏接守卫即红。

详见 [`client-routing-and-deeplink`](../../skills/client-routing-and-deeplink/SKILL.md);
域名与回调 URL 的归属见 [`domain-boundary`](../../skills/domain-boundary/SKILL.md)。

## 共同模式

| 步骤 | 做法 |
| --- | --- |
| 1. 找到「所有实例」的枚举方式 | 路由目录、`pages.json`、源码 AST、错误码表 |
| 2. 让每个实例必须被人显式分类 | 允许 / 禁止 / 豁免(附理由) |
| 3. 默认落入「红」而不是「绿」 | 新增 = 未分类 = 失败 |
| 4. 自检探针 | 脚本自己带正反例,保证检查器没有悄悄失效 |
| 5. 把「豁免」写成带理由的登记项 | 理由给下一个人看,不是给机器看 |

## 机制 × React 落地 × uniapp 落地

| 机制 | React(Next / React Native) | uniapp |
| --- | --- | --- |
| 唯一 API 客户端 | 一个 `apiClient` 模块(fetch/axios 封装);lint 禁止业务代码直接 `fetch` / 引入 axios | 封装 `uni.request` 适配层;lint 禁止直接调用 `uni.request`/`uni.uploadFile` |
| 幂等键 | 意图层生成一次、传入请求层;整树扫描禁 `Math.random` 拼键 | 同左,在页面/store action 层生成;`crypto` 不可用时用统一 polyfill 模块而非随机回退 |
| 重放策略 | 客户端拦截器按「幂等读 / 带键写 / 禁止重放」表决定是否自动重试 | 在 `uni.request` 适配层同一张表;小程序切后台恢复时按表重放 |
| 错误分类展示 | 错误码 → 类别 → i18n key 表;组件只渲染表结果,禁止渲染 `error.message` | 同一张表(纯 JSON 共享);`uni.showToast` 只接受表产出的文案 |
| 平台 SDK 收口 | 原生能力(推送、分享、存储)只经 `platform/` 包装层;lint 禁止业务代码直接 import 插件 | 条件编译(`#ifdef MP-WEIXIN` 等)只允许出现在 `platform/` 目录;业务层调用统一接口 |
| i18n key 门禁 | 扫描 `t('...')` 字面量 ⊆ 各 locale 目录,缺 key 即红(见 [ui-locale-boundary](./ui-locale-boundary.md)) | 扫描 `$t('...')`(vue-i18n)与 `pages.json` 中的标题 key,同样门禁 |
| 深链白名单 | `Linking`/`appUrlOpen` 入口调 `resolveDeepLink`;区域清单对照路由目录 | `plus.runtime.arguments` / 小程序启动参数先过 `resolveDeepLink`;清单对照 `pages.json`;`uni.addInterceptor` 拦截跳转 |
| 埋点脱敏 | reporter 入队前 `sanitize` + 路由模板归一 + 捕获时冻结账号 scope | 同一套纯函数;`uni.setStorageSync` 队列按条数/年龄淘汰 |
| 强制升级 | API 客户端注入版本头;`mustUpdate = force \|\| current < minSupported` | `uni.getAppBaseInfo` 取版本;App 端 `plus.runtime.install`,小程序端更新管理器;判定函数共用 |

后三行对应的完整规则见
[`client-telemetry-contract`](../../skills/client-telemetry-contract/SKILL.md) 与
[`mobile-app-build`](../../skills/mobile-app-build/SKILL.md) 的
[`client-version-compat`](../../skills/mobile-app-build/references/client-version-compat.md)。
