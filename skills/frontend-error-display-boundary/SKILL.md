---
name: frontend-error-display-boundary
description: Use when classifying API/network errors, deciding what error text a user sees, mapping backend business codes to copy, or writing optimistic updates with rollback, in React (Next / React Native) or uniapp projects.
---

# Frontend Error Display Boundary

「错误怎么分类、用户能看到什么」的框架无关规范。locale 缺失时的回退（某语言没有译文怎么办）归
[`../ui-locale-boundary/SKILL.md`](../ui-locale-boundary/SKILL.md)，本 skill 只管「**什么内容允许被展示**」与「**错误先分类再决策**」。
请求侧约束（超时、重放、幂等）见 [`../frontend-api-client-contract/SKILL.md`](../frontend-api-client-contract/SKILL.md)。

## 为什么

案例项目「Nova」的两类事故：

- 后端把业务错误包成 `Error("40104: ticket expired")` 抛给前端，页面直接 `toast(error.message)`，用户看到带数字前缀的英文开发者字符串；更糟时是堆栈片段或 SQL 报错原文，既难看又泄露内部结构。
- 乐观更新（先改 UI/缓存，再等服务端）失败时只回滚、不提示：用户看到开关/数字变了又变回去，不知道发生了什么。更严重的一批连 `onError` 都没有，乐观值永久卡住。

## 规则（不变量）

1. **先分类，后展示**。错误在 api-client 层就被归入**封闭**的 kind 集合，UI 只依赖 kind 与业务码，不解析 `message` 字符串：

   | kind | 含义 | 典型来源 |
   | --- | --- | --- |
   | `network` | 没有拿到响应 | 离线、DNS、TLS、连接被重置 |
   | `timeout` | 超过客户端超时 | 超时定时器 / 平台超时错误 |
   | `unauthenticated` | 未登录或会话失效 | HTTP 401（刷新失败后） |
   | `forbidden` | 已登录但无权限 | HTTP 403 |
   | `business` | 后端业务拒绝，带业务码 | 信封里 `code != 0` |
   | `validation` | 请求参数不合法 | HTTP 422 / 校验码 |
   | `unknown` | 以上都不是 | 兜底，同时上报 |

   用户主动取消（abort）不是错误，单独忽略，不弹提示。分类函数是纯函数，要穷举测试；新增 kind 必须让 `switch` 的 `never` 检查在编译期报红。
2. **业务码只有存在「人工审过的译文」才展示对应文案**（curated 表：`code → { locale → 文案 }`）。没有译文就显示**通用文案**（「请求失败，请稍后重试」之类，由调用方传入）。
3. **后端原始 `message`、堆栈、SQL、请求 id 之外的内部细节一律只进日志/上报，永不直接渲染**。展示前若 `message` 带 `<code>: ` 这类前缀，也不允许「剥前缀后透传」当作兜底，因为剥完的正文仍是未审文案。
4. **curated 表由测试保证每个已支持 locale 都齐全**：表里每个 code 必须在每个 locale 有非空译文；新增 locale 时测试立刻红，逼你补齐，而不是静默回退。
5. **乐观更新必须有失败回滚 + 用户可见提示**：`onMutate` 里写了乐观状态，就必须有 `onError`，且其中既回滚又提示（toast/内联错误）。
6. 唯一展示入口：项目里只允许一个「把错误变成用户文案」的函数，页面不得各自拼文案。

## 怎么机器强制

- **单元测试（分类）**：对每个 kind 造输入（网络错误、超时、401/403/422、带业务码的信封、乱七八糟的对象），断言输出 kind；业务码优先于信封 message 里恰好出现的「connection」等传输类词汇。
- **单元测试（curated 齐全）**：

  ```ts
  for (const [code, byLocale] of Object.entries(CURATED)) {
    for (const loc of SUPPORTED_LOCALES) {
      expect(byLocale[loc]?.trim(), `${code}/${loc}`).toBeTruthy();
    }
  }
  ```
- **单元测试（不泄露）**：对「未收录 code + 含 SQL/堆栈/英文原文的 message」断言返回的是通用文案，且返回值不包含原文任何片段。
- **lint**：禁止在 JSX/模板里渲染 `error.message`：

  ```js
  'no-restricted-syntax': ['error',
    { selector: "JSXExpressionContainer > MemberExpression[property.name='message'][object.name=/^(e|err|error)$/]",
      message: 'Render formatUserFacingError(error), never error.message.' },
    { selector: "CallExpression[callee.name=/^(toast|showToast)$/] > MemberExpression[property.name='message']",
      message: 'Render formatUserFacingError(error), never error.message.' },
  ]
  ```
  uniapp 的 `.vue` 模板用 `eslint-plugin-vue` 的 `vue/no-restricted-syntax`（或 `vue/no-restricted-v-bind` 视情况）写同样的选择器；`uni.showToast({ title: err.message })` 用 CallExpression 选择器拦。
- **乐观更新 AST 检查**（先 advisory）：用 TypeScript 解析器找 `useMutation({ onMutate, onError })`：
  - `onMutate` 内出现 `setQueryData` / `setQueriesData` 或 `setXxx/patchXxx/toggleXxx` 之类写状态调用；
  - 没有 `onError` → 违规 `missing-onerror`（更严重）；
  - 有 `onError` 但函数体里没有 `toast(...)` 的**真实调用表达式**（或调用同文件内一个自身会 toast 的具名函数）→ 违规 `missing-toast`。
  必须用 AST 而不是正则：正则会被注释里的 `// TODO: toast(...)` 或字符串字面量骗过。脚本带自检探针（构造一个已知违规与一个已知合规样例，确认两者判定正确）。
  - **advisory → hard**：默认只打印、退出码 0（先观察命中面）；加 `--strict` 才以非零退出。升级路径：① 存量清零或记入基线文件（只许减不许增）；② 把 `--strict` 变体接进合并前必跑的静态契约组；③ 把脚本登记进「改了哪些文件就选哪些检查」的选择器，否则它永远不会被触发，等于没有门禁。不要长期停在 advisory。

## React（Next / React Native）落地

```ts
// api-client/errors.ts
export type ErrorKind = 'network' | 'timeout' | 'unauthenticated' | 'forbidden'
  | 'business' | 'validation' | 'unknown';
export interface ClassifiedError { kind: ErrorKind; code?: number; raw: unknown }

export function classify(e: unknown): ClassifiedError | { kind: 'aborted' } { /* 纯函数 */ }

// ui/format-error.ts —— 唯一展示入口
export function formatUserFacingError(e: unknown, generic: string, locale: Locale): string {
  const c = classify(e);
  switch (c.kind) {
    case 'aborted': return '';
    case 'network': return t('errors.network');
    case 'timeout': return t('errors.timeout');
    case 'unauthenticated': return t('errors.sessionExpired');
    case 'forbidden': return t('errors.forbidden');
    case 'business': case 'validation': {
      const copy = c.code != null ? CURATED[c.code]?.[locale] : undefined;
      if (!copy) report('uncurated_code', { code: c.code, raw: c.raw });  // 原文只进上报
      return copy ?? generic;
    }
    case 'unknown': report('unknown_error', { raw: c.raw }); return generic;
    default: { const _x: never = c; return generic; }
  }
}
```

乐观更新（TanStack Query）：

```ts
useMutation({
  mutationFn: api.post.like,
  onMutate: async (id) => {
    await qc.cancelQueries({ queryKey: ['post', id] });
    const prev = qc.getQueryData(['post', id]);
    qc.setQueryData(['post', id], (p) => ({ ...p, liked: true }));
    return { prev };
  },
  onError: (e, id, ctx) => {
    qc.setQueryData(['post', id], ctx?.prev);                  // 回滚
    toast(formatUserFacingError(e, t('errors.requestFailed'), locale)); // 提示
  },
  onSettled: (_d, _e, id) => qc.invalidateQueries({ queryKey: ['post', id] }),
});
```

RN 里 `toast` 换成项目的 Toast/Snackbar 组件，规则不变。

## uniapp 落地

api-client 封装层（`uni.request` 的 `success`/`fail`）直接产出同一份 `ClassifiedError`：`fail` 里根据 `errMsg`（含 `timeout`、`request:fail`）归 `timeout` / `network`，`success` 里按 `statusCode` 与信封 `code` 归其余几类；`classify` 与 `formatUserFacingError` 可与 React 项目共用同一份纯 TS 源（放进可共享包），只有「如何弹提示」是平台相关的：

```ts
// 页面/store 里只调用统一入口
const msg = formatUserFacingError(err, t('errors.requestFailed'), i18n.global.locale.value);
if (msg) uni.showToast({ title: msg, icon: 'none' });
```

Pinia 里的乐观更新（点赞、置顶、静音）：

```ts
export const usePostStore = defineStore('post', () => {
  const liked = ref<Record<string, boolean>>({});
  async function like(id: string) {
    const prev = liked.value[id];
    liked.value[id] = true;                         // 乐观写入
    try {
      await api.post.like(id);
    } catch (e) {
      liked.value[id] = prev;                       // 回滚
      uni.showToast({ title: formatUserFacingError(e, t('errors.requestFailed'), locale()), icon: 'none' });
    }
  }
  return { liked, like };
});
```

对应的 AST 检查针对「store action 里在 `await` 之前写了状态、`catch` 里没有 toast/showToast」这一形态；Vuex 的 `commit` 同理。`.vue` 与 `.ts` 的 locale 目录要有一份「已支持 locale」的单一来源，curated 齐全性测试读它，而不是另抄一份。
