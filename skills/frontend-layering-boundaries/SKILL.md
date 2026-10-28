---
name: frontend-layering-boundaries
description: Use when adding or reviewing frontend code (React/Next/React Native or uniapp) that crosses feature boundaries, touches native/platform SDKs, grows a file or dependency list, or hard-codes colors/spacing. Turns module boundaries, platform-SDK containment, size/complexity budgets and design-token ownership into machine-checked facts.
---

# Frontend Layering & Boundaries

和 [backend-layering](../backend-layering/SKILL.md) 同一思路:前端架构规则如果只靠评审"恰好
注意到",就会在赶工时被绕过。本 skill 把四类规则变成脚本能判定的事实。「基线只减不增」的通用
机制(baseline 文件、更新规则、advisory → strict)见
[backend-governance-ratchets](../backend-governance-ratchets/SKILL.md),这里只讲前端特有部分。

下文路径(`src/features`、`@/lib/platform`)和阈值都是**示例值**,按项目调整;不变量才是重点。

## 1. 模块只经公开入口互相引用

**为什么**:feature 之间一旦深路径 import(`@/features/order/internal/utils`),内部文件就成了
隐式公共 API,重构一个目录会炸一片调用方。

**规则**
- 每个 feature/模块只有一个公开入口(`index.ts`,uniapp 同理);其他模块、路由/页面层只能 import 入口。
- 基础设施层(`lib/`、`utils/`)不得反向依赖 feature。
- 共享包有**依赖矩阵**:如 `types` → 无依赖;`api-client` → `types`;`ui` → `types`、`tokens`;
  应用 → 任意包;包永不依赖应用。矩阵写成数据,由脚本读各 `package.json` 与 import 校验。

**机器强制**
- ESLint `no-restricted-imports` 拦深路径(快反馈,编辑器内可见);
- 一个独立的架构检查脚本校验依赖矩阵、循环依赖、禁用依赖清单(ESLint 不擅长跨包图);
- 新增 feature 用脚手架生成,默认带 `index.ts`。

### React(Next/RN)落地
```js
// eslint.config.mjs —— 路由层只能碰 feature 入口,lib 层不许碰 feature
{ files: ['src/app/**/*.{ts,tsx}'],
  rules: { 'no-restricted-imports': ['error', { patterns: [
    { group: ['@/features/*/*'], message: 'Import feature public API (index) only.' } ] }] } },
{ files: ['src/lib/**/*.{ts,tsx}'],
  rules: { 'no-restricted-imports': ['error', { patterns: [
    { group: ['@/features', '@/features/**'], message: 'lib must not depend on features.' } ] }] } },
```
Monorepo 另加 `eslint-plugin-boundaries` 或 `dependency-cruiser` 做矩阵/循环检查。

### uniapp 落地
结构相同(`src/features/<name>/index.ts`、`src/pages/**` 只 import 入口)。别名在 `vite.config`/
`tsconfig` 的 `paths` 里配 `@/`,ESLint 规则与上面完全一致(vue 文件需 `vue-eslint-parser`,`files`
加上 `**/*.vue`)。pages.json 中的页面路径不受此规则约束,但页面文件本身受。

## 2. 原生/平台 SDK 收口到 adapter 层

**为什么**:feature 直接调用 `Capacitor.*`、RN 原生模块、`uni.*`/`wx.*`/`plus.*`,会让业务代码绑死
某个运行时,Web/测试环境无法 mock,平台判断散落各处且口径不一(某处漏了 mock 覆盖,e2e 就失效)。

**规则**
- 只有 `platform/`(或 `lib/native/`)下的 adapter 可以 import/调用原生 SDK;对外暴露**带类型的
  最小接口**(`share()`、`getSafeArea()`),并提供 Web/测试 fallback。
- 平台判断(是否原生、哪个平台)只有一个出口函数,feature 不得自己嗅探。

**机器强制**:ESLint 在 `features/**` 里禁 import / 禁全局;adapter 目录豁免。新规则先 `warn`
(advisory),存量清零或进 baseline 后升 `error`。

### React(Next/RN)落地
```js
{ files: ['src/features/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': ['error', { patterns: [
      { group: ['@capacitor/*', 'react-native-*'], message: 'Use a typed adapter from @/lib/platform.' } ] }],
    'no-restricted-globals': ['error', { name: 'Capacitor', message: 'Use platform adapter.' }],
  } }
```
RN 里 `react-native` 本身是框架而非"原生 SDK",只禁第三方原生模块(相机、推送、IAP 等)。

### uniapp 落地
`uni`、`wx`、`plus` 是全局对象,用 `no-restricted-properties` 拦成员访问:
```js
{ files: ['src/features/**/*.{ts,vue}', 'src/pages/**/*.{ts,vue}'],
  rules: { 'no-restricted-properties': ['error',
    { object: 'uni', message: 'Use src/platform adapter (e.g. platform/storage.ts).' },
    { object: 'wx',  message: 'Use src/platform adapter.' },
    { object: 'plus', message: 'Use src/platform adapter.' } ] } }
```
adapter 内部用条件编译(`#ifdef MP-WEIXIN`)隔离多端差异,feature 只看到统一接口。需要放行的
纯 UI API(如 `uni.showToast`)应在 adapter 里包一层,而不是给 feature 开白名单。

## 3. 体积/复杂度棘轮

**为什么**:文件、函数、依赖是"温水煮青蛙"式增长,没有硬上限就没人会主动拆。

**规则与强制**(阈值均为示例值)
| 维度 | 示例上限 | 工具 |
| --- | --- | --- |
| 单文件行数 | 400 行 | 脚本统计 / ESLint `max-lines` |
| 圈复杂度 | 15 | ESLint `complexity` |
| 每个 `package.json` 的依赖数 | 每个包一个预算 | 脚本读取 `dependencies` 等字段 |
| 死代码(无引用的文件/导出/依赖) | 0 新增 | `knip` 一类工具 |

- 超限的存量文件登记进 baseline(记录当前值);之后**只允许降、不允许升**,新文件不得进 baseline。
- 依赖预算降到新低后,同一提交里把预算数字下调(棘轮收紧);有意增长必须在预算旁注明理由。
- 死代码工具先 report-only 跑出存量 baseline,再切到"只拦新增"模式;不要一上来要求清零。
- 禁用依赖清单(已被内部封装替代的库,如直接的日期库/HTTP 库)同样由脚本检查。

### React(Next/RN)落地
`knip.json` 配 `entry`(Next 的 `app/**`、`pages/**`)与 `project`;Next/Metro 的约定入口要显式声明,
否则会误报。`eslint` 的 `max-lines` 设 `skipComments: true`。

### uniapp 落地
`knip` 的 `entry` 要包含 `src/main.ts`、`src/pages.json` 中列出的页面与 `manifest.json`(页面靠
pages.json 注册,而不是 import,不声明会全部被判死代码)。`.vue` 文件行数统计包含
`<template>`+`<script>`+`<style>` 全部,与 React 的单文件口径保持可比。

## 4. 设计 token 单一字面量源

**为什么**:颜色/间距字面量散落在业务样式里,主题切换(暗色、品牌升级)就变成全仓库搜索替换。

**规则**
- 字面量值(`#7c3aed`、`16px`)只出现在 token 源文件;其余一律引用 token。
- 语义层(`--color-surface`)引用原始层(primitives);暗色主题只是同一语义名在另一 scope 的重新赋值,
  且只有一处定义。
- 业务代码不得硬编码颜色/间距;新增视觉值先加 token。

**机器强制**:stylelint 禁字面量 + 脚本校验 token 文件的 import 顺序与"谁能定义字面量"。

### React(Next/RN)落地
Web:CSS 变量(`:root` + `[data-theme='dark']`)或 TS token 对象,stylelint:
```json
{ "rules": { "color-no-hex": true, "declaration-property-value-disallowed-list": { "/^(color|background|border)/": ["/^rgba?\\(/", "/^hsla?\\(/"] } },
  "overrides": [{ "files": ["packages/tokens/**"], "rules": { "color-no-hex": null } }] }
```
React Native 没有 CSS:token 是 TS 对象,用 ESLint `no-restricted-syntax` 匹配样式里的字面量
`/^#[0-9a-f]{3,8}$/i`(规则只作用于 `StyleSheet.create` 与 `style=` 附近,避免误伤普通字符串)。

### uniapp 落地
变量定义在 `uni.scss`(全局注入),页面 `<style lang="scss">` 只写 `$color-primary` 等变量;
stylelint 同样启用 `color-no-hex`,`uni.scss` 通过 overrides 豁免。小程序不支持部分 CSS 变量特性,
所以 SCSS 变量是主路径;若同时需要运行时换肤再叠一层 CSS 变量,但字面量仍只在 token 源。

### advisory → hard 升级路径
1. **advisory**:规则 `warn`/脚本默认 exit 0,只打印命中,记录存量数量;
2. **baseline**:存量进 baseline 文件,新增命中才失败("只拦新增");
3. **hard**:存量清零(或明确豁免清单),规则升 `error`、baseline 删除。
每一步都应在 PR 里可见,且新增的检查脚本要有"自检探针"(故意写坏的样例必须被报出),避免检查
脚本自己坏了而恒绿。升级节奏与门禁分级见 [backend-governance-ratchets](../backend-governance-ratchets/SKILL.md)。

## 提交前检查
- 新 import 是否走了公开入口?新原生调用是否落在 adapter?
- 有没有新增文件超行数、新依赖、新硬编码颜色?若有,是在修 baseline 而不是加进 baseline?
