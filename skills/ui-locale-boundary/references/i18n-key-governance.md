# i18n Key 双向门禁

类型层面的 `Record<Locale, X>` 只能保证"locale 集合完整",保证不了"词条与代码引用一致"。后者需要
一个扫描脚本做**双向**检查,外加各 locale 之间的 parity。

## 四条检查

1. **缺失(代码有、词条无)→ 必须失败。** 多数 i18n 库在 key 缺失时要么运行时抛错,要么静默
   显示 key 名;两种都是只在特定分支才暴露的线上 bug,typecheck 与 lint 拦不住。
2. **孤儿(词条有、代码零引用)→ 失败,或先 advisory。** 孤儿会腐烂成"没人敢删"的文案。
   - 已确认要保留但暂未引用的 key(提前上线的文案、下个版本使用),写进**登记表**(planned key),
     每条带前缀、状态、负责人/原因;登记表为空时任何孤儿都是缺陷。
   - 登记不是终态:过期未使用的登记项应被清理,脚本可对"登记但已被引用/已不存在"的条目报错。
3. **locale parity → 必须失败。** 每个 locale 的 key 集合必须完全一致(逐 key 对比,不只是文件
   数量)。新增 locale 或新增 key 漏翻译即失败。期望的 locale 集合用字面量快照固定,避免自比较。
4. **动态拼接 key → 不允许"悄悄跳过"。** 扫描器无法解析 `t(\`status.${s}\`)`,而这恰好是孤儿检查
   最容易误杀、缺失检查最容易漏报的地方。处理方式二选一:
   - 改成**静态映射表**(`const STATUS_KEY = { open: 'status.open', ... } as const`),key 以字面量出现;
   - 或**登记前缀**(`status.`)为"动态家族",扫描器视该前缀下所有词条为已引用,并要求家族成员
     在各 locale 间 parity。
   优先前者;前缀登记只是过渡方案。

## 扫描口径建议
- 判定保守:缺失检查只解析"同文件内声明的翻译器 + 字面量 key",`t` 作为参数跨文件传递时整体跳过,
  换取零假阳性;孤儿检查用"全名/末段子串出现即算活",宁可漏报也不误杀。已知漏报写进脚本头部注释。
- 默认 advisory(打印、exit 0),`--strict` 才 exit 1;先出存量清单再升级,路径见
  [frontend-layering-boundaries](../../frontend-layering-boundaries/SKILL.md) 的 advisory → hard 与
  [backend-governance-ratchets](../../backend-governance-ratchets/SKILL.md)。
- 脚本自带自检探针:内置一个故意缺失/孤儿的 fixture,检测不到就报脚本自身损坏。

## 落地
- **React**:i18next 扫描 `t('ns:key')`/`useTranslation(ns)`;next-intl 扫描
  `useTranslations('ns')` + `t('key')` 并拼出完整路径。可用 `i18next-parser`/`i18next-cli` 的
  "提取后 diff"模式作为现成起点,再补登记表。
- **uniapp**:vue-i18n 扫描 `$t('a.b')`、`t('a.b')` 与模板里的 `{{ $t(...) }}`,需要同时解析 `.vue`
  的 template 与 script;locale 文件常见为 `locales/*.json` 或 TS 对象,先统一展开为扁平 key 集合再比对。
