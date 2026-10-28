---
name: test-database-isolation
description: Use when writing or reviewing database or integration tests, test fixtures, or CI lanes that need a real database — enforces fail-instead-of-skip, disposable prefixed databases, host-allowlist safety checks, and static scans for shared IDs and fixture bypasses.
---

# Test Database Isolation(测试库隔离)

数据库测试最危险的两种失败:**悄悄不跑**(缺库就 skip,CI 一片绿但什么都没验证)和**误伤真库**
(测试连上了开发/预发库,跑了清理 SQL)。这份规范用四条规则把两者都堵住。示例以 PostgreSQL 为主,
其它数据库用对应的"建库/删库/强制断连"机制即可。

## 规则 1:缺库即红,不 skip

DB/集成测试所在的车道(lane)里,没有库就是**失败**,不是跳过:

- 车道通过专用环境变量拿到测试库地址;变量缺失或不安全 → 抛出明确错误,测试失败。
- 禁止 `pytest.mark.skipif(no_db)`、`if (!url) return` 这类静默分支;也禁止"缺了就回落到一个默认库名"——
  回落的库在某些运行方式下并不存在,连接失败后用例被误判为跳过,真实事故即由此而来。
- "需要真库"的用例用显式标记(如 `-m db`)归入专门车道;该车道的运行器负责提供库,提供不了就整车道红。

```python
# pytest: conftest.py
import os, pytest

class TestDatabaseUnavailable(RuntimeError): ...

def require_test_database_url() -> str:
    url = (os.environ.get("APP_TEST_DATABASE_URL") or "").strip()
    if not url:
        raise TestDatabaseUnavailable("APP_TEST_DATABASE_URL is required; DB tests fail, never skip")
    if not is_safe_test_host(url):
        raise TestDatabaseUnavailable("test database must be loopback or a dedicated test host")
    return url
```

```ts
// Vitest / Jest: test-db.ts
export function requireTestDatabaseUrl(env = process.env): string {
  const url = (env.APP_TEST_DATABASE_URL ?? '').trim();
  if (!url) throw new Error('APP_TEST_DATABASE_URL is required; DB tests fail, never skip');
  if (!isSafeTestHost(url)) throw new Error('test database must be loopback or a dedicated test host');
  return url;
}
```

## 规则 2:一次性库 + 前缀 + 强制删除

每个需要独占库的测试(尤其迁移回放、破坏性用例)建自己的一次性库:

- 库名 = 固定前缀 + 用途 + 随机后缀(如 `app_test_<purpose>_<hex>`);前缀让清理脚本和人都能一眼认出;
- 用完在 `finally`/fixture teardown 里 `DROP DATABASE IF EXISTS ... WITH (FORCE)`(PostgreSQL 13+;
  其它版本先终止该库的活动连接再删),不留残骸;
- 失败现场想保留时,用显式开关(如 `--keep-on-failure`),而不是默认不清理;
- 并发(多 worker)时,共享模板库的"重放迁移"一步用跨进程文件锁串行,同进程只做一次。

```python
@pytest.fixture
def scratch_db():
    base = require_test_database_url()
    name = f"app_test_{secrets.token_hex(4)}"
    with psycopg.connect(with_dbname(base, "postgres"), autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        yield with_dbname(base, name)
    finally:
        with psycopg.connect(with_dbname(base, "postgres"), autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
```

```ts
// Vitest: 一次性库 fixture
import { test as base } from 'vitest';
import { randomBytes } from 'node:crypto';

export const test = base.extend<{ scratchDb: string }>({
  scratchDb: async ({}, use) => {
    const baseUrl = requireTestDatabaseUrl();
    const name = `app_test_${randomBytes(4).toString('hex')}`;
    const admin = await connect(withDbName(baseUrl, 'postgres'));
    await admin.query(`CREATE DATABASE "${name}"`);
    try { await use(withDbName(baseUrl, name)); }
    finally { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end(); }
  },
});
```

Jest 等价写法:`beforeEach` 建库、`afterEach` 删库,或用 `globalSetup`/`globalTeardown` 管理模板库。

## 规则 3:安全判据看**主机白名单**,不看库名像不像测试库

"库名里带 test"不是安全证据——一个远端的、真实的数据库完全可以叫 `app_test`,也可以被人用
`test` 命名后接着存真数据。破坏性操作(建库、重放迁移、清理)之前的准入判据:

- **主机白名单**:只放行 loopback(`localhost` / `127.0.0.1` / `::1`)和明确登记的专用测试主机;
  其它一律拒绝,包括托管数据库的已知域名后缀(再加一层黑名单标记作为额外保险,但白名单才是主判据);
- 协议/驱动也要在允许集合内;
- 准入函数只写**一份**,所有入口(fixture、脚本、迁移回放工具)导入同一个,不各写一份近似判据;
- 一次性库的前缀只用于"识别与清理",不参与"是否安全"的判断。

```python
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
DEDICATED_TEST_HOSTS: set[str] = set()   # 项目登记的专用测试主机

def is_safe_test_host(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in LOCAL_HOSTS or host in DEDICATED_TEST_HOSTS
```

## 规则 4:只读专用环境变量

测试地址只从为测试车道专门导出的环境变量读取(如 `APP_TEST_DATABASE_URL`):

- 不读业务运行时用的 `DATABASE_URL`,不从 `.env`/环境配置文件里"找一个能用的";
- 变量由车道运行器/CI 导出,开发者本地也显式导出,而不是代码里写默认值;
- 测试代码不得修改这些变量去"借用"别的库。

## 静态扫描:把违规挡在合入前

写一个只读的静态检查(可用 `ast` / 正则 / TypeScript 编译器 API),扫描全部 DB/集成测试:

| 违规 | 为什么危险 | 检查什么 |
| --- | --- | --- |
| 共享硬编码 ID(`user_123`、`post_abc`) | 并行 worker/重跑互相踩数据 | 匹配"前缀_字面量"形态的 ID;要求改用 fixture 提供的命名空间/唯一 ID 生成器 |
| 散落 cleanup SQL(`DELETE FROM ...` 写在用例里) | 清理范围无人审查,漏清或误清 | 禁止在用例中直接写 DELETE;只允许经 fixture 的清理入口;极少数受控探针单独白名单并绑定函数名 |
| 绕过隔离 fixture 直接建连接(`create_engine(...)`、`new Pool(...)`) | 绕过主机准入与一次性库 | 只允许 fixture/testkit 目录内创建连接;其余出现即违规 |
| 引用真实环境配置/远端数据库域名 | 误连真库 | 扫描对环境配置文件与托管域名的引用 |

检查器要有**基线文件**记录存量违规(带校验和),新规则只拦"新增",存量逐步清零;检查器自身扫到 0 个文件
或解析失败必须失败,不能静默通过。

## 自查清单

1. 缺库时用例是红的吗?全仓有没有 `skip` 式回落?
2. 一次性库有前缀、有 `WITH (FORCE)` 清理吗?
3. 准入看的是主机白名单,且只有一份实现吗?
4. 地址只来自测试专用变量吗?
5. 静态扫描覆盖共享 ID、散落 DELETE、绕过 fixture 吗?

## 与其它 skill 的关系

迁移回放演练见 [migration-downpath](../migration-downpath/SKILL.md);擦除类 DML 的"每条带 WHERE"测试
见 [data-erasure-boundary](../data-erasure-boundary/SKILL.md)。
