# 编码卫生门禁(`hygiene`)

kit 自带的机器门禁,覆盖 [SKILL.md](../SKILL.md) 中能静态判定的规则。实现位于 kit 的
`src/hygiene/`:Go 规则用语法树分析(`go/ast`,只依赖标准库),格式与行长对所有纳入的文件生效。
基线遵守 [backend-governance-ratchets](../../backend-governance-ratchets/SKILL.md) 的不变量。

## 命令

```bash
node .vibe-coding/kit/cli.mjs hygiene check --project-root . [--config <path>] [--base-ref origin/main]
node .vibe-coding/kit/cli.mjs hygiene write-baseline --project-root . \
  --owner <团队> --expiry <YYYY-MM-DD> --issue <工单> --removal-plan "<还债计划>"
```

- `check` 输出 JSON:`ok`、`filesScanned`、`totals`(按规则计数)、`failures`、`warnings`;失败退出码 1。
- `write-baseline` 把当前命中记为存量。首次需要四个元数据参数;之后沿用旧值。基线**变大**时拒写,
  确需放宽时设置 `HYGIENE_BASELINE_GROWTH_REASON=<原因>`,原因会打印出来供评审引用。

## 规则

| 规则 | 对应 | 判定 |
| --- | --- | --- |
| `nil-context-check` | R2 | `context.Context` 参数(或名为 `ctx` 的参数)与 `nil` 比较 |
| `nil-receiver-guard` | R1 | 方法体内接收者与 `nil` 比较 |
| `reflect-nil-probe` | R3 | 导入 `reflect` 的文件中调用 `.IsNil()` |
| `scattered-recover` | R5 | 调用 `recover()`;唯一的拦截器用豁免登记 |
| `wide-condition` | R12 | `if` 条件中 `&&`/`\|\|` 连接的子条件数超过 `wideConditionMax`(默认 6) |
| `collapsed-error` | R4 | 在 `err != nil`(含 `e`、`*Err` 命名)分支里直接返回一个 `Err*` 哨兵且不引用该错误 |
| `unknown-field-rejection` | R7 | 调用 protobuf 的 `GetUnknown()` |
| `composition-root-data-access` | R10 | `compositionRoots` 中的文件导入 `dataAccessImports` 匹配的包 |
| `gofmt` | R13 | `gofmt -l` 列出的文件 |
| `line-length` | R13 | 超过 `lineLengthMax`(默认 160)字符的行,对所有纳入文件生效 |

自动排除:带 `// Code generated ... DO NOT EDIT.` 头的 Go 文件。测试文件用 `exclude` 排除(模板默认
排除 `*_test.go`)。TypeScript/Python 目前只有行长规则;R7 的前端严格比对、R8、R9、R11、R14 靠评审。

## 配置 `.vibe-coding/code-hygiene.json`

```json
{
  "schemaVersion": 1,
  "include": ["internal/**/*.go"],
  "exclude": ["**/*_test.go"],
  "baseline": ".vibe-coding/code-hygiene-baseline.json",
  "baseRef": "origin/main",
  "wideConditionMax": 6,
  "lineLengthMax": 160,
  "compositionRoots": ["internal/bootstrap/**"],
  "dataAccessImports": ["example.com/app/internal/database"],
  "disabledRules": []
}
```

- glob 中 `*` 匹配一段,`**` 匹配任意深度。`dataAccessImports` 按前缀匹配导入路径,支持 `*` 段。
- 扫描范围是已跟踪文件加未忽略的新文件,已删除的文件不计入。
- `disabledRules` 用于项目确实不适用的规则(例如项目对外只暴露公网接口,R7 的拒收是边界策略)。
  关掉规则是项目决策,在项目文档里写明理由。

## 基线与棘轮

基线文件结构:

```json
{
  "version": 1,
  "owner": "platform", "expiry": "2027-05-31", "issue": "ARCH-12", "removal_plan": "按包清理",
  "scope": { "include": ["..."], "exclude": ["..."], "fileCount": 2307 },
  "total": 12345,
  "debt": [{ "rule": "nil-context-check", "path": "a/b.go", "symbol": "Server.Start", "count": 3 }],
  "exemptions": [{ "rule": "scattered-recover", "path": "a/interceptor.go", "symbol": "Recover", "count": 1,
                   "reason": "唯一的 panic 拦截器" }]
}
```

- key 是 `规则 + 文件 + 符号`(函数或 `类型.方法`;文件级规则符号为空),不含行号,编辑不漂移。
- 当前数量超过 `debt + exemptions` → 失败(新增债务)。少于 → 失败(陈旧条目),运行
  `write-baseline` 缩小基线。豁免不再命中时也必须手动删掉。
- 提供 `baseRef` 时,工作区的基线与 merge-base 版本比较:任一条目变大、新增条目、`total` 变大、
  `include` 被删或 `exclude` 新增,都算增长并失败(设置放宽原因时降级为警告)。
- 扫描文件数低于 merge-base 记录的一半,或为 0 → 失败(防扫描塌缩)。
- 四个元数据字段必须非空;`expiry` 过期即失败,30 天内到期给警告。

豁免只用于**合理且永久**的位置(唯一的拦截器、真正的信任边界),必须精确到符号并写明理由;临时
债务进 `debt`,不进 `exemptions`。

## 接入项目 gate

把 `hygiene check` 接进项目的检查脚本或 worktree adapter 的 `verifyCandidate`。在 CI 中显式传
`--base-ref` 指向目标分支。新接入且噪音未知的项目可以先只报告,确认误报率后再改为阻断,并在项目
文档写明升级条件与负责人。
