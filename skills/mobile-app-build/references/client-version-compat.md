# 客户端版本兼容与强制升级

适用于任何带原生壳或可长期驻留旧版本的客户端（Capacitor、React Native、uniapp App 端、小程序）。

## 规则

1. **每个请求上报版本与平台**：统一在唯一 API 客户端里加请求头（示例 `X-App-Version` / `X-App-Build` / `X-App-Platform`），
   业务代码不得自己拼。服务端据此做兼容判断、灰度分桶与日志切片。
2. **强制升级判定**：`must_update = latest.force_update OR current_build < latest.min_supported_build`。
   比较用单调递增的 build 号（整数），不用语义化版本字符串。`force_update` 是紧急旁路，
   可绕过灰度比例与白名单，使用时必须记录原因。
3. **灰度白名单只认已登录身份**：白名单（按用户 ID）与分桶（`hash(release_id + identity) % 100`）只对已登录账号命中；
   匿名设备永不命中白名单。匿名请求即使稳定落桶，也只能走比例灰度或默认不可见，不得因设备标识伪造白名单命中。
4. **旧版本仍在线时，API 不得破坏性改名/改语义**：重命名字段、删端点、改枚举含义都按
   [`api-contract-change`](../../api-contract-change/SKILL.md) 走「新增并行 → 观测旧版本流量归零 → 再下线」，
   下线时机以 `min_supported_build` 抬升为准。
5. 强制升级页本身必须能在最旧受支持版本上渲染：升级检查端点属于最稳定契约，不随业务 API 改版。

## 机器强制

- 契约测试：构造矩阵（force × current/min_supported × 登录/匿名 × 白名单命中/未命中）断言 `must_update` 与可见性；
  断言匿名身份在任何白名单配置下都不命中。
- API 兼容测试：保留最近受支持版本的请求/响应快照，对当前后端重放，破坏性差异即红。
- lint：禁止业务代码绕过唯一 API 客户端直接发请求（否则版本头缺失）。

## 落地示意

```ts
// React/RN 与 uniapp 共用的纯函数
export const mustUpdate = (r: { force: boolean; minSupported: number }, current: number) =>
  r.force || current < r.minSupported;
```

- React/RN：版本取自原生壳（如 `expo-application` / Capacitor `App.getInfo()`），在 API 客户端拦截器里注入请求头。
- uniapp：`plus.runtime.getProperty` 或 `uni.getAppBaseInfo()` 取版本；请求头在封装的 `uni.request` 适配层注入；
  App 端升级走 `plus.runtime.install`，小程序端走平台自带更新管理器，判定函数共用。
