---
name: client-telemetry-contract
description: Use when adding or changing client analytics/product events, event properties, the event reporter or offline report queue, URL/route fields sent to telemetry, or account switching behavior in a React (Next/React Native) or uniapp client.
---

# Client Telemetry Contract

客户端埋点是「把用户行为发到你自己的后端」，三个常见事故：事件名/属性各端各写一套对不上；URL、手机号、token
被原样上报；离线队列无限增长或切换账号后旧事件记到新账号头上。本 skill 把它们收成可测试的契约。

## 为什么

- 事件名靠口头约定，前端拼错一个字母后端就静默丢弃，看板上是「事件少了」而不是报错。
- 动态路由（`/watch/8f3a...`）和 query（`?token=...&email=...`）被当作页面标识上报，既泄露标识符，又让基数爆炸。
- 弱网/离线时队列只增不减会撑爆存储；重试无上限会放大流量。
- 事件在**发送时**才读取当前账号，则「账号 A 离线产生、切到账号 B 后补发」的事件会归给 B。

## 规则（不变量）

1. **事件目录单一登记表**：每个事件有 `name`、属性 schema（字段、类型、是否必填、长度上限）、`owner`、状态
   （active/deprecated）。前端、后端、数仓读同一份（或由同一份生成）。命名统一风格，如 `domain.object_action`。
2. **未登记即失败**：上报入口收到未登记事件名或不符合 schema 的属性 ⇒ 开发/测试环境抛错，生产环境丢弃并计数告警
   （告警本身不带原始载荷）。后端入口同样按目录拒收，作为第二道。
3. **上报前脱敏**（在落盘/入队之前做，而不是发送时）：
   - 按 key 片段剔除 PII：`email`、`phone`、`mobile`、`password`、`token`、`secret`、`cookie`、`authorization`、`apikey` 等（key 先小写并去掉非字母数字再匹配）；
   - 按 value 形态剔除：邮箱、手机号（10-15 位）、JWT、`Bearer ...`、`key=value` 形式的凭证；
   - 动态路由归一为模板：`/watch/:videoId`、`/profile/orders/:id`；
   - URL 一律去掉 query 与 fragment；搜索词截断长度并按上面的 value 规则再过一遍；
   - 递归处理嵌套对象与数组。
4. **离线队列有界**：队列条数上限、单条最大年龄、单条最大重试次数、指数退避有上限。淘汰策略明确（先丢过期，再丢最旧）。
   具体阈值是项目参数，例如「200 条 / 24 小时 / 5 次 / 退避封顶 5 分钟」仅为示例。
5. **捕获时冻结账号归属**：事件创建瞬间写入 scope 快照 `{ ownerUid | null, anonymousId, deviceId, sessionId, experimentHeader }`，
   之后无论登录态如何变化都不再重读。`ownerUid = null` 表示设备级匿名事件，只能以匿名身份发送，**不得**补上后来登录的账号。
6. **幂等与去重**：每条事件有创建时生成的稳定 `clientEventId` 与 `occurredAt`，响应丢失重试时服务端可去重。
7. 目录变更走与 API 相同的兼容规则：旧版本客户端仍在发的事件名不得直接删除，先 deprecated（参见
   [`../api-contract-change/SKILL.md`](../api-contract-change/SKILL.md)）。

## 怎么机器强制

| 守卫 | 失败条件 |
| --- | --- |
| 目录一致性测试 | 源码里所有 `track('...')` 的字面量事件名 ⊆ 目录；目录里 active 事件在后端 schema 中有同名定义 |
| 类型层 | 事件名与属性由目录生成联合类型，`track()` 签名只接受目录内事件（TS 编译期即红） |
| 脱敏向量测试 | 固定载荷表（邮箱、手机号、JWT、嵌套 token、带 query 的 URL、动态路由）→ 断言输出不含原值 |
| 队列属性测试 | 注入超量/过期/重试耗尽条目，断言长度与淘汰顺序；断言入队后的条目 scope 不随当前登录态变化 |
| 禁用直连 | lint 禁止业务代码直接调用 SDK/`fetch` 上报，只能经 reporter |

## React（Next / React Native）落地

```ts
// event-catalog.ts —— 单一登记表（可由 JSON/OpenAPI 生成）
export const EVENT_CATALOG = {
  'video.play_start': { owner: 'growth', props: { videoId: 'string', source: 'string?' } },
  'search.submit':    { owner: 'search', props: { queryLen: 'number' } },
} as const;
export type EventName = keyof typeof EVENT_CATALOG;

export function track<N extends EventName>(name: N, props: PropsOf<N>) {
  if (!(name in EVENT_CATALOG)) return reportRejected(name);       // 运行时兜底
  const scope = snapshotScope();                                    // 捕获时冻结
  enqueue({ clientEventId: uuid(), occurredAt: Date.now(), name,
            props: sanitize(props), scope });
}

const ROUTE_TEMPLATES: [RegExp, string][] = [[/^\/watch\/[^/]+\/?$/, '/watch/:videoId']];
export function normalizeRoute(url: string) {
  const path = url.split(/[?#]/)[0];
  return ROUTE_TEMPLATES.find(([re]) => re.test(path))?.[1] ?? path;
}
```

- Next：服务端组件/Route Handler 不应直接上报客户端事件；浏览器端 reporter 用 `navigator.sendBeacon` 作页面关闭兜底。
- React Native：队列落 AsyncStorage/MMKV，应用回前台与网络恢复时 flush；flush 前按 scope 判断匿名条目能否发送。
- 路由模板表与「路由清单」同源维护，新增动态路由时同时补模板（可并入
  [`../client-routing-and-deeplink/SKILL.md`](../client-routing-and-deeplink/SKILL.md) 的分类测试）。

## uniapp 落地

```js
// reporter.js
export function track(name, props) {
  if (!EVENT_CATALOG[name]) return reportRejected(name);
  const scope = snapshotScope();
  const queue = uni.getStorageSync('report_queue') || [];
  queue.push({ clientEventId: uuid(), occurredAt: Date.now(), name, props: sanitize(props), scope });
  uni.setStorageSync('report_queue', pruneQueue(queue)); // 过期 + 条数淘汰
}
uni.onNetworkStatusChange((r) => r.isConnected && flush());
```

- 页面标识用 `getCurrentPages()` 末项的 `route`（已是无 query 的 `pages/xx/yy`），query 来自 `options` 的部分不要上报。
- 小程序端 `uni.request` 受域名白名单约束，上报域名也需登记（见 [`../domain-boundary/SKILL.md`](../domain-boundary/SKILL.md)）。
- `uni.setStorageSync` 有容量上限，必须依赖规则 4 的淘汰而不是假设够用。
- 目录文件用纯 JSON，使 uniapp 与 React 端、后端共享同一份，脱敏函数写成无依赖纯函数便于各端复制并做 parity 测试。
