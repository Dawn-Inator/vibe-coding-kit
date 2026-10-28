---
name: client-routing-and-deeplink
description: Use when adding or changing client routes, deep-link/universal-link handling, post-login redirect targets, route auth guards, or any "navigate to a URL that came from outside" code path in a React (Next/React Native) or uniapp client.
---

# Client Routing & Deep Link

外部输入（自定义 scheme、universal link、`?redirect=`、推送 payload、分享链接）进入客户端后会变成一次「站内跳转」。
本 skill 管三件事：深链准入、站内跳转目标校验、路由登录守卫。域名/回调 URL 本身归属见
[`../domain-boundary/SKILL.md`](../domain-boundary/SKILL.md)，本 skill 不重复。

## 为什么

- 自定义 scheme（`nova://`）在 Android/iOS 上**没有归属校验**：任何第三方 app、任意网页的
  `<a href="nova://...">` 都能把任意 path 送进你的 app。universal link 虽有归属校验，path 仍然是外部可控的。
- 「解析成功就放行」「改写器当校验器用」都是 default-allow：一个 `normalize(path) ?? path` 式的函数只负责改写，
  没命中规则的路径会原样返回，却常被误当成「已校验」。结果是未来新增的任何页面自动变成可被外链直达。
- 登录后 `?redirect=//evil.com`、`/\evil.com`、`%2f%2fevil.com` 这类值会造成开放重定向。
- 需要登录的路由漏接守卫是静默故障：没有报错，只是未登录用户看到了壳页面或发出了 401 请求。

## 规则（不变量）

1. **深链默认拒绝**：入口只认一张显式清单（单一真源），不认黑名单、不认「能解析」。
2. **每个一级路由区域必须被显式分类**为三类之一：
   `allowed`（可被深链直达）/ `auth-required`（可进入但必须登录，落到守卫）/ `denied`（禁止外部直达，如支付内部步骤、调试页）。
   新增区域未分类 ⇒ 测试红。清单里出现已不存在的区域 ⇒ 也红（防止死条目堆积）。
   「允许进入」不等于「允许消费凭证」：回调页消费 token 另需一次性 pending-state 校验。
3. **站内跳转目标只走一个 `isSafeInternalPath`**：只接受以单个 `/` 开头的站内相对路径；拒绝
   `//` 开头、反斜杠、控制字符（≤0x1F、0x7F）、解码（最多两层）后出现以上任一情形、畸形 `%` 序列，
   且用哨兵 origin 解析后 origin 必须不变。该函数只做判定，不改写。
4. **多包副本必须 parity**：当某个包因加载环境限制（轻量测试加载器、不同构建链、小程序端）不能 import 共享实现而持有副本时，
   用测试断言函数体/行为逐字一致（读两份源码比对规范化后的函数体，再加同一组攻击向量表跑两份实现）。
5. **路由与登录守卫契约表**：枚举所有路由，每条必须且只能落进两类：(A) 链路上检出守卫；(B) 在
   `PUBLIC_ROUTES` 里登记并写明理由。判据一句话：**该路由渲染的内容或提供的动作是否绑定「当前登录账号」？**
   绑定 ⇒ 必须守卫，不得登记 public；登记 public 却检出守卫 ⇒ 矛盾，也红。守卫检测用 AST/配置解析，不用 grep
   （注释、字符串里提到守卫名不算）。

## 怎么机器强制

| 守卫 | 失败条件 |
| --- | --- |
| 深链分类测试 | 扫描路由目录（或 `pages.json`）得到一级区域集合，与 ALLOWED/AUTH/DENIED 三表比对：未分类、重复分类、死条目都红 |
| safe-path 向量测试 | 固定攻击向量表：`//x`、`/\x`、`/%5Cx`、`/%255Cx`、`/%2F%2Fx`、`https://x`、`javascript:`、控制字符、空值 |
| parity 测试 | 各副本对同一向量表输出一致；函数体规范化后相等 |
| 登录守卫契约脚本 | 路由集合 ⊆ (有守卫 ∪ PUBLIC_ROUTES)；PUBLIC_ROUTES 每条有理由；自检探针（脚本能识别已知正/反例）失败直接 exit 2 |

脚本应 fail-closed：新增路由默认落不进任何一类，必须由人显式判断一次。违规退出码非 0，进 pre-merge 门禁。

## React（Next / React Native）落地

```ts
// deep-link-allowlist.ts —— 单一真源
export const ALLOWED_DEEP_LINK_AREAS = ['watch', 'discover', 'share', 'login'] as const;
export const AUTH_REQUIRED_AREAS = ['profile', 'wallet'] as const; // 进入后由守卫接管
export const DENIED_DEEP_LINK_AREAS = ['dev', 'payment-internal'] as const;

export function resolveDeepLink(raw: string): string | null {
  const path = extractPath(raw);                 // 去 scheme/host，保留 path+query
  if (!isSafeInternalPath(path)) return null;
  const area = path.split(/[/?#]/)[1];
  if (DENIED_DEEP_LINK_AREAS.includes(area as never)) return null;
  const known = [...ALLOWED_DEEP_LINK_AREAS, ...AUTH_REQUIRED_AREAS];
  return known.includes(area as never) ? path : null; // 默认拒绝
}

// 登录后回跳
const next = isSafeInternalPath(params.get('redirect')) ? params.get('redirect')! : '/';
```

- Next：区域集合从 `app/` / `pages/` 目录扫描；守卫是 layout/page 里的 `useRequireAuth()` 或 `<RequireAuthGate>`，契约脚本用 TypeScript AST 找它们并沿 import 跟随到真正组件。
- React Native：`Linking`/`appUrlOpen` 的回调第一行调用 `resolveDeepLink`，返回 null 就丢弃并上报一次被拒事件（脱敏，见
  [`../client-telemetry-contract/SKILL.md`](../client-telemetry-contract/SKILL.md)）。

## uniapp 落地

`pages.json` 的 `pages` / `subPackages` 就是路由清单；分类测试读取它，而不是扫目录。

```js
// router-guard.js —— 在 main.js 注册
const AUTH_REQUIRED = ['pages/profile/index', 'pages/wallet/index'];
const PUBLIC = new Set(['pages/feed/index', 'pages/login/index']);
['navigateTo', 'redirectTo', 'reLaunch', 'switchTab'].forEach((api) => {
  uni.addInterceptor(api, {
    invoke(args) {
      if (!isSafeInternalPath(args.url)) return false;        // 阻断非法目标
      const route = args.url.split('?')[0].replace(/^\//, '');
      if (AUTH_REQUIRED.includes(route) && !store.isLoggedIn) {
        uni.navigateTo({ url: '/pages/login/index?redirect=' + encodeURIComponent(args.url) });
        return false;
      }
    },
  });
});
```

- 拦截器注意：`navigateTo` 拦截器拦不住 `<navigator>` 之外的原生返回，也拦不住 tabBar 点击——tabBar 页面要在页面 `onShow` 再做一次守卫。
- 契约脚本：解析 `pages.json`，断言每个 `path` 要么在 `AUTH_REQUIRED`（并且页面 `onLoad/onShow` 或拦截器表里有对应项），要么在 `PUBLIC`。
- 外部唤起（App 端 `plus.runtime.arguments`、小程序启动参数 `query`/`path`）同样先过 `resolveDeepLink`。
- 小程序等不能 import 共享包的端按规则 4 持有副本并写 parity 测试。

## 反模式

- 用黑名单（「不许 `/admin`」）代替默认拒绝。
- 把路径改写函数当校验函数。
- 只靠手工清单决定「哪些路由要登录」，且清单漏写时静默放行。
- 在每个调用点手写 `startsWith('/')` 而不是调用统一函数。
