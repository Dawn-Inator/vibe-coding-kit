# merge-base 读取与防塌缩的实现细节

## 读取 merge-base 的 blob

```python
def resolve_merge_base(repo, base_ref, head="HEAD") -> str:
    ref = (base_ref or os.environ.get("BASELINE_BASE_REF", "")).strip()
    if not ref or set(ref) == {"0"}:          # 缺失或全 0 sha: fail closed
        raise SystemExit("explicit base ref required")
    return git(repo, "merge-base", ref, head).strip()

def read_json_at_ref(repo, commit, path):
    return json.loads(git(repo, "show", f"{commit}:{path}"))   # 固定 argv, 不过 shell
```

```ts
import { execFileSync } from "node:child_process";
const mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], { encoding: "utf8" }).trim();
const previous = JSON.parse(execFileSync("git", ["show", `${mergeBase}:${path}`], { encoding: "utf8" }));
```

要点:

- 只用固定 argv 调用 git,不拼 shell 字符串。
- 调用前清掉环境里会改变仓库发现的变量(`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE` 等),
  否则从别的工具链嵌套调用时可能读到错误的仓库。
- 浅克隆的 CI 里 merge-base 可能不存在:fail closed 并提示 fetch 深度,而不是退回工作树。
- 文件在 merge-base 不存在(首次引入)是合法的"播种"情形;文件曾存在却读失败才是错误。
- 文件被重命名/搬迁时,用 `git diff -M --name-status` 追踪,避免"旧路径消失"被当成债务消失、
  "新路径出现"被当成新增。注意 git 在改动路径很多时会静默跳过相似度重命名检测,需显式放大
  `diff.renameLimit`。

## 增长度量

```python
BUDGET_KEY = re.compile(r"(count|budget|total|limit)", re.I)

def measure(node, path, out):
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, bool): continue
            if isinstance(v, int) and BUDGET_KEY.search(k): out[f"{path}.{k}"] = out.get(...,0)+v
            else: measure(v, f"{path}.{k}", out)
    elif isinstance(node, list):
        out[path+"[]"] = out.get(path+"[]", 0) + len(node)
        for item in node: measure(item, path+"[]", out)
```

形状无关:不同检查器的基线结构不同,按"任意数组长度 + 任意预算类整数"通用比较。同一份拷贝会
放进多个需要写入器的位置时,用一个测试钉住各拷贝一致,防止漂移。

## 防塌缩:独立盘点下限

```python
def census(root) -> int:        # 更宽松的路径规则: 路径任一段含 "test" 才排除
    return sum(1 for p in root.rglob("*.py") if "test" not in str(p).lower() and SQL_SHAPE.search(p.read_text()))

def assert_not_collapsed(scanned: int, root, min_fraction=0.5):
    floor = math.ceil(census(root) * min_fraction)
    assert scanned >= floor, f"scan collapsed: {scanned} < floor {floor}"
```

盘点与扫描**用不同的规则路径**,这样扫描侧的过滤写坏时,盘点侧不会跟着一起坏。比例用 0.5 之类
宽松值,容忍盘点的粗糙,只拦"扫到 0 或近乎 0"。其它形状的下限:基线条目数不得少于 merge-base
的条目数减去本次声明已修复的数;扫描到的"槽位文件数"不得低于目录盘点数。

## 跨副本一致:读源码常量,不维护两份可变副本

当两个独立项目(各自的包、各自的虚拟环境)无法互相 import,却要共用同一套规则常量时,允许第二份
实现,但它必须用 AST 直接读对方**源文件里的常量字面量**逐项比对,而不是两份可变副本互相校验:

```python
tree = ast.parse(Path(other_repo_rules).read_text())
upstream = {n.targets[0].id: ast.literal_eval(n.value)
            for n in tree.body if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)}
assert upstream["ALLOWED_METHODS"] == LOCAL_ALLOWED_METHODS   # 上游改了, 这里立刻变红
```

TypeScript 版用 `ts.createSourceFile` 读 `const` 初始化器并比较。

## hard / advisory 的实现

```python
parser.add_argument("--strict", action="store_true")
...
sys.exit(1 if (failures and args.strict) else 0)
```

约定:本地/开发分支默认 advisory,发布与主干分支传 `--strict`。升级路径写进规则文档:
"哪一个分支、在什么条件下由 advisory 改为 strict"。过期预警(30 天内)永远是 advisory。
