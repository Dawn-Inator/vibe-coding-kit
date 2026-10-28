---
name: backend-governance-ratchets
description: Use when a project already carries legacy violations of a backend rule and needs a shrink-only baseline (ratchet) instead of a big-bang cleanup, or when adding/reviewing any baseline, allowlist, exemption or budget file in a governance gate.
---

# 存量债务基线棘轮(Governance Ratchets)

[backend-layering](../backend-layering/SKILL.md) 的结构检查(`backend-check`)是**零债务**的:没有
历史白名单,发现即失败。这对新项目是最好的起点。但已经长了几年的项目没法一天清零——一开门禁就
几百条红,团队只会把门禁关掉。**棘轮**解决这个矛盾:把存量违规冻结进一份机器可读的基线,规则
变成"**只减不增**":新代码零容忍,旧债务只能被还掉,不能被扩大,更不能被悄悄收编。

选择路径:

| 项目状态 | 做法 |
| --- | --- |
| 新项目 / 新服务 | 直接用 `backend-check` 零债务起步,不建基线 |
| 已有存量违规 | 先用棘轮冻结存量,逐步还债,最终归零后基线文件保留为"空基线"继续守住 |
| 基线归零 | 条目为空、预算为 0;从此与零债务等价,但"再长出来"的路径仍被棘轮守着 |

棘轮不替代 `backend-check`,是它之外的补充:凡是 `backend-check` 没覆盖、或项目暂时无法零债务的
规则(见 [backend-layering 的机器门禁一节](../backend-layering/SKILL.md)),都可以套这套机制。

## 八条不变量

一个棘轮只有同时满足下面八条才是真棘轮;缺任何一条,基线都会退化成"只会越长越大的白名单"。

1. **存量进 JSON 基线,只减不增。** 当前扫描结果超出基线 = 失败;基线里已不再命中的条目(陈旧)
   = 同样失败,必须删除。这样每还一笔债,基线就必须同步缩小,"修了但没删"的条目不会积累成
   以后可被复用的空洞。
2. **写基线的工具自检,条目变多/预算变大即拒写。** `--write-baseline` 之类的重生入口是最大的
   漏洞:开发者一键把当前违规全部"登记"为存量,等于关门禁。写入前拿新负载与磁盘上旧文件比较,
   任意数组变长、任意 count/budget/total/limit 整数变大都拒绝写入。放宽只能显式进行:设置一个
   环境变量(例如 `BASELINE_GROWTH_REASON=<原因>`),本次运行打印原因,供评审引用。首次创建
   (磁盘上没有旧文件)允许播种存量。按**数量**而非条目身份比较,这样行号漂移、部分条目被修复
   不会被误判为增长。
3. **基线从 merge-base 的 git blob 读,不信工作树。** 对比"上一版基线"必须取
   `git show <merge-base>:<path>`,而不是磁盘上的文件。否则同一个改动里既新增违规、又顺手把
   基线改大,自检看到的"旧基线"已经是被改过的,棘轮形同虚设。base ref 必须显式传入(CLI 参数
   或环境变量),缺失、全 0、无法解析一律 fail closed。详见
   [merge-base 读取](references/merge-base-and-collapse.md) 与
   [教程](../../tutorial/06-codebase-architecture/governance-ratchets.md)。
4. **每份基线/豁免都带 `owner / expiry / issue / removal_plan`,过期硬失败。** 四个字段都必须是
   非空字符串,`expiry` 是 ISO 日期,早于今天就让整个检查失败。过期日不是提醒,是强制复核点:
   债务没有人认领、没有计划,就不允许继续存在。到期前一段时间(示例:30 天)给 advisory 预警,
   不改退出码。复核周期分档:有真实存量的棘轮约半年一审,已归零的守卫约一年一审,避免所有
   基线撞同一天到期变成"全员红"。
5. **豁免精确到 `path + symbol (+ 行号或序号) + 非空理由`。** 不允许整文件豁免、不允许通配、
   不允许没有理由。key 里尽量不放行号(行号随编辑漂移),用符号限定名或"同符号第 N 处"。
   豁免条目不是特权,是对一笔具体债务的登记。
6. **防扫描塌缩。** 扫描路径过滤写坏、目录改名、glob 不再命中,扫描器会安静地扫到 0 个文件,
   于是"无违规"——假绿。每个扫描型棘轮必须断言扫描规模有下限,而且下限**不是手填的魔法数**,
   而是从一次**独立盘点**推出来:盘点用更宽松的规则数出"本该被扫的目标",扫描器实际检查数
   必须 ≥ 盘点数 × 比例(示例 0.5)。基线自身的 scope 字段也受 merge-base 约束:不得相对旧版
   收窄。
7. **分 hard / advisory 两级,advisory 要有升级路径。** hard 阻断合入;advisory 只打印、退出码为 0,
   适合刚引入、噪声未知的新规则,或需要真库/慢链路的检查。advisory 不是终态:必须写明升级条件
   (例如"连续一个周期零误报后在 staging 分支改为 strict"),并有 owner。长期停在 advisory 的
   规则等于没有规则。
8. **预算类基线(budget)同样棘轮。** 例如"此路由允许的批量上限""此查询路径允许的最大查询数"
   这类数字,只能下调;上调走第 2 条的显式放宽通道。

## 最小基线示例

```json
{
  "version": 1,
  "owner": "platform-architecture",
  "expiry": "2027-01-31",
  "issue": "ARCH-123",
  "removal_plan": "按域逐个迁移到 query/projection 槽位,每迭代清零一个域",
  "scope": {
    "service": "app/service/**/*.py excluding tests",
    "database": "app/database/**/*.py excluding tests"
  },
  "finding_count": 2,
  "findings": [
    {
      "rule": "silent_broad_except",
      "path": "app/service/billing/invoice/service.py",
      "symbol": "InvoiceService.refresh_cache",
      "ordinal": 1,
      "reason": "缓存预热失败可忽略,待改为 best_effort 作用域"
    },
    {
      "rule": "silent_broad_except",
      "path": "app/service/billing/invoice/service.py",
      "symbol": "InvoiceService.render_pdf",
      "ordinal": 1,
      "reason": "第三方渲染偶发失败,待加结构化日志"
    }
  ]
}
```

`finding_count` 与 `findings` 长度必须一致(或由检查器校验),让"数量"本身也成为被棘轮的预算。

## 检查器伪代码

```python
def check(current: list[Finding], baseline_path, base_ref) -> list[str]:
    failures = []
    base = read_json_at_merge_base(base_ref, baseline_path)   # git blob, 不读工作树
    work = read_json(baseline_path)                           # 当前工作树版本

    failures += metadata_failures(work)           # owner/expiry/issue/removal_plan, 过期即失败
    failures += scope_must_not_narrow(base, work) # scope 不得相对 merge-base 收窄
    if len(work.findings) > len(base.findings):   # 工作树基线不得比 merge-base 更大
        failures.append("baseline grew vs merge-base")
    if scanned_count < floor_from_independent_census():       # 防塌缩
        failures.append("scan collapsed")

    keys = {f.key() for f in work.findings}       # key = rule+path+symbol+ordinal
    for f in current:
        if f.key() not in keys:  failures.append(f"new violation {f}")
    for k in keys - {f.key() for f in current}:
        failures.append(f"stale baseline entry {k}; delete it")   # 陈旧即失败
    for f in work.findings:
        if not f.reason.strip(): failures.append(f"empty reason {f.key()}")
    return failures

def write_baseline(new_payload, path):            # --write-baseline 入口
    old = try_read(path)
    if old is not None:
        grown = measure_growth(old, new_payload)  # 数组长度、count/budget/total/limit 整数
        if grown and not os.environ.get("BASELINE_GROWTH_REASON"):
            sys.exit(f"refusing to grow baseline: {grown}")
        elif grown: print("growth allowed:", os.environ["BASELINE_GROWTH_REASON"], grown)
    path.write_text(json.dumps(new_payload, indent=2, sort_keys=True))
```

TypeScript/Node 的形状一样:`git show ${mergeBase}:${path}` 用 `child_process.execFileSync`(不过 shell),
JSON 解析后比较数组长度与预算整数,失败路径 `process.exit(1)`。Go 同理用 `exec.Command("git", ...)`。
语言无关的是八条不变量,不是脚本。

## 接入步骤

1. 选一条要治理的规则,先**只报告**,统计存量。
2. 写检查器(优先用 AST/语法树而非正则,见 [backend-guardrails](../../tutorial/06-codebase-architecture/backend-guardrails.md)),
   输出稳定 key。
3. 用重生入口首次播种基线(此时允许"增长",因为文件不存在),填好四个元数据字段。
4. 接上 merge-base 读取、增长自检、塌缩下限;把检查接入项目的 gate。
5. 新规则先 advisory,写明升级条件与 owner,再升级为 hard。
6. 每次还债同时缩小基线;归零后保留空基线。

细节与更多写法见 [references/merge-base-and-collapse.md](references/merge-base-and-collapse.md)。

## 常见反模式

- 在工作树里读"旧基线"来比较增长。
- 重生入口无增长自检,或自检可被默默绕过(放宽不打印理由)。
- 豁免写成整个目录或不带理由;key 含行号导致每次编辑都要改基线。
- 基线有 `expiry` 但检查器只打印不失败。
- 扫描结果为 0 时报绿;下限写死成手填常数,目录改名后常数不再有意义。
- advisory 规则从没有升级条件,几个月后无人记得它存在。
