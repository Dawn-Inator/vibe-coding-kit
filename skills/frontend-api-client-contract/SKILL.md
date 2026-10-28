---
name: frontend-api-client-contract
description: Use when writing or reviewing front-end code that sends HTTP requests, retries or replays them, generates idempotency keys, refreshes auth tokens, or builds request payloads against a backend schema, in React (Next / React Native) or uniapp projects.
---

# Frontend API Client Contract

适用于任何「前端调后端 HTTP API」的项目。框架无关的是不变量；React 与 uniapp 只是落地方式不同。
后端契约本身的变更纪律见 [`../api-contract-change/SKILL.md`](../api-contract-change/SKILL.md)，本 skill 管客户端这一侧。

## 为什么

案例项目「Nova」的教训（化名，只取结构）：

- 每个页面各自 `fetch`，超时、重试、鉴权头、错误分类各写一遍，改一处漏五处。
- 后端 DTO 拒绝多余字段（返回 422），客户端多塞一个字段，线上才发现。
- 重试把没有幂等键的 POST 重放了第二次，用户被扣两次款。
- 幂等键生成函数在 Web Crypto 不可用时回退到 `Math.random()`。**规则早就写在文档里，但没有任何门禁**，结果三处资金场景代码各自实现了一遍 `Math.random` 回退。可预测的幂等键会碰撞，碰撞等于把别人的请求当成自己的已完成请求。
- 多个并发请求同时拿到 401，各自去刷新 token，刷新令牌被轮换后其余刷新全部失败，用户被莫名登出。

结论：这些都是「写在文档里的约定」会被多人、多 AI 会话慢慢磨掉的类别，必须落成机器检查。

## 规则（不变量）

1. **分层单向**：页面/组件 → hook/store → **唯一** api-client 层 → 由后端 schema 生成的类型。上层不得越级；api-client 层是整个项目里唯一允许触碰底层 HTTP 原语的地方。
2. **业务代码禁止直接调用 HTTP 原语**：`fetch`、`axios`、`XMLHttpRequest`、`uni.request`、`wx.request`、`Taro.request` 等，只能出现在 api-client 包内。
3. **请求体字段 ⊆ schema 声明字段**。后端若 `extra=forbid`，多余字段就是 422；即使后端宽容，也算契约漂移。
4. **只重放安全请求**：自动重试/重放只允许 `GET` / `HEAD`，或带**非空**幂等键的 `POST`。其它方法、空串或纯空白幂等键一律不重放。
5. **每个请求有超时，且可取消**。取消产生的错误与超时、网络错误是三种不同的错误，不能混为一谈（分类见 [`../frontend-error-display-boundary/SKILL.md`](../frontend-error-display-boundary/SKILL.md)）。
6. **幂等键只用密码学安全随机**；无安全随机源时**直接抛错、请求不发出**，**禁止回退 `Math.random`、时间戳、自增计数**。
7. **token 刷新单飞**：并发 401 只触发一次刷新，其余请求排队等同一个结果；刷新失败统一走「清会话 + 登出」，不得每个请求各自处理。
8. 关键端点（鉴权、支付、提现等）有逐端点契约测试：断言 method、path、payload，**用真实调用记录**，不做源码文本匹配。

## 怎么机器强制

### 1) Lint：禁止越过 api-client 层

```js
// eslint.config.js（flat config 示意；api-client 包自身 override 为 off）
export default [
  {
    files: ['src/**/*.{ts,tsx,vue}'],
    ignores: ['packages/api-client/**'],
    rules: {
      'no-restricted-globals': ['error',
        { name: 'fetch', message: 'Use the api-client layer.' },
        { name: 'XMLHttpRequest', message: 'Use the api-client layer.' },
      ],
      'no-restricted-imports': ['error', { paths: [
        { name: 'axios', message: 'Use the api-client layer.' },
        { name: 'ky', message: 'Use the api-client layer.' },
      ] }],
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.object.name=/^(uni|wx|my|tt|Taro)$/][callee.property.name='request']",
          message: 'Use the api-client layer.' },
        { selector: "CallExpression[callee.object.name=/^(uni|wx)$/][callee.property.name=/^(uploadFile|downloadFile)$/]",
          message: 'Go through the api-client upload helper.' },
        { selector: "MemberExpression[object.name='window'][property.name='fetch']",
          message: 'Use the api-client layer.' },
      ],
    },
  },
];
```

注意别名绕过（`const f = fetch`、`globalThis.fetch`）；有存量时用基线棘轮：基线只许减不许增。

### 2) Lint + 测试：幂等键模块禁止 `Math.random`

```js
{
  files: ['**/*idempoten*.{ts,js}', '**/secure-random*.{ts,js}', '**/payments/**', '**/wallet/**'],
  rules: {
    'no-restricted-syntax': ['error',
      { selector: "MemberExpression[object.name='Math'][property.name='random']",
        message: 'Idempotency keys must use a CSPRNG; never fall back to Math.random.' },
    ],
  },
}
```

仅靠上面的 glob 仍会漏掉「资金场景里自己实现的第四处」。再加一条**整树测试**：扫描全部源码，任何文件里同时出现「idempotency / requestId / nonce 类标识符」与 `Math.random`，即失败；允许名单必须带理由且只减不增。**规则没有门禁等于没有规则**，这一条要接进提交/合并前的必跑集合。

### 3) 测试：payload 与 schema 对齐

用 TypeScript 解析器（只做语法分析，不需要类型检查器）扫描 api-client 里所有 `.post(path, { json: <expr> })`：

- `<expr>` 是对象字面量 → 取其键（含可解析的 spread）；
- 是标识符 → 取所在函数形参的手写接口/类型字面量的属性；
- 引用自动生成类型的不用查（与 schema 同源，不会漂移）；
- 与 OpenAPI 请求 schema 的 `properties` 比较，客户端多出的字段即失败。

无法静态解析的调用**计数并跳过**，同时设一个覆盖率下限（示例：可解析比例不得低于某个阈值），防止守卫悄悄退化成空操作。

### 4) 测试：关键端点逐端点断言

给 http 层注入一个「录制」实现，调用真实的端点工厂函数，断言录下来的 `method`、`path`、`payload`：

```js
const { http, calls } = createRecordingHttp({ ok: true });
const ep = createAuthSecurityEndpoints({ http });
await ep.changePassword({ currentPassword: 'a', newPassword: 'b', changeTicket: 't' });
assert.deepEqual(calls[0], {
  method: 'POST',
  path: 'user/authentication/password/self/update',
  json: { currentPassword: 'a', newPassword: 'b', changeTicket: 't' },
});
```

不要写「读源码文件、正则找路径字符串」的测试：重构、拼接、注释都会骗过它。

## React（Next / React Native）落地

唯一 api-client 层包一个 `fetch`（RN 同样有 `fetch`；SSR 里注意每请求独立实例，避免 token 串用）：

```ts
// api-client/transport.ts
const isReplaySafe = (method: string, headers: Headers) =>
  method === 'GET' || method === 'HEAD' ||
  (method === 'POST' && !!headers.get('idempotency-key')?.trim());

export function createIdempotencyKey(c: Crypto | undefined = globalThis.crypto): string {
  if (typeof c?.randomUUID !== 'function') throw new Error('Secure random unavailable');
  return c.randomUUID();            // RN 需先注册 polyfill（如 react-native-get-random-values）
}

let refreshing: Promise<string> | null = null;           // 单飞
const refreshOnce = () => (refreshing ??= doRefresh().finally(() => { refreshing = null; }));

export async function request(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const method = (init.method ?? 'GET').toUpperCase();
  for (let attempt = 1; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new DOMException('timeout', 'TimeoutError')), init.timeoutMs ?? 15_000);
    init.signal?.addEventListener('abort', () => ctl.abort(init.signal!.reason));
    try {
      let res = await fetch(BASE + path, { ...init, headers: withAuth(init.headers), signal: ctl.signal });
      if (res.status === 401) {                          // 并发 401 共享同一次刷新
        try { await refreshOnce(); } catch { await logout(); throw classify401(); }
        res = await fetch(BASE + path, { ...init, headers: withAuth(init.headers), signal: ctl.signal });
      }
      return res;
    } catch (e) {
      if (attempt < 2 && isReplaySafe(method, new Headers(init.headers)) && isTransientNetwork(e)) continue;
      throw e;
    } finally { clearTimeout(timer); }
  }
}
```

hook 层用 TanStack Query；页面只见 hook：

```ts
export function useWithdraw() {
  return useMutation({
    mutationFn: (v: WithdrawInput) =>
      api.wallet.withdraw(v, { idempotencyKey: createIdempotencyKey() }), // 失败重试时复用同一个 key，见下
  });
}
```

要点：**同一次用户意图的重试复用同一个键**（在 mutation 的 variables 或闭包里生成一次），不要每次重试重新生成，否则幂等失效。TanStack Query 的 `retry` 对 mutation 默认为 0，保持默认，重放只在 api-client 层的受控规则里发生。

## uniapp 落地

`uni.request` 是回调式、不可由 `AbortController` 取消，要用返回的 `RequestTask.abort()`；统一封成 Promise，并用 `uni.addInterceptor` 做鉴权头与 401 处理的**一处**入口：

```ts
// api-client/request.ts
let refreshing: Promise<string> | null = null;
const refreshOnce = () => (refreshing ??= doRefresh().finally(() => { refreshing = null; }));

export function request<T>(o: { url: string; method?: 'GET' | 'POST'; data?: object;
  header?: Record<string, string>; timeoutMs?: number; signal?: { onAbort(cb: () => void): void } }) {
  return new Promise<T>((resolve, reject) => {
    const task = uni.request({
      url: BASE + o.url, method: o.method ?? 'GET', data: o.data,
      header: o.header, timeout: o.timeoutMs ?? 15000,   // 超时在 fail 里 errMsg 含 "timeout"
      success: (r) => (r.statusCode >= 200 && r.statusCode < 300 ? resolve(r.data as T) : reject(toApiError(r))),
      fail: (e) => reject(toNetworkOrTimeout(e)),
    });
    o.signal?.onAbort(() => task.abort());               // RequestTask.abort
  });
}

// main.ts：只在一处挂拦截器
uni.addInterceptor('request', {
  invoke(args) { args.header = { ...args.header, Authorization: `Bearer ${getToken()}` }; },
});
```

401 处理放在封装层（`success` 里判断 `statusCode === 401` 后 `await refreshOnce()` 再重发一次，失败则 `logout()`），**不要**在每个页面里写。幂等键的安全随机源按平台取：

```ts
export function secureRandomUuid(): string {
  // H5 / 部分小程序基座：globalThis.crypto；App(Vue) 与小程序需用基座提供的安全随机 API 或已审核的 polyfill
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) { const b = c.getRandomValues(new Uint8Array(16)); /* 按 RFC4122 v4 格式化 */ return fmtV4(b); }
  throw new Error('Secure random unavailable');   // 不回退 Math.random
}
```

各小程序平台是否提供安全随机源要逐个核实后写进适配表；某平台没有就让该平台的资金类请求直接失败并提示，而不是降级。状态层用 Pinia/Vuex 持有 token 与「正在刷新」的 Promise；与 React 版相同，刷新 Promise 放模块级或 store 内，不放组件。
