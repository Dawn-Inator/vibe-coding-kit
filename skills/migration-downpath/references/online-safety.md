# 迁移线上安全(展开篇)

本文是 [SKILL.md](../SKILL.md)「线上安全」一节的细则。示例以 PostgreSQL 为主,其它数据库请找对应机制
(超时参数、在线建索引、元数据锁)。

## 1. 每条 DDL 先限时,再动手

DDL 要拿强锁(PostgreSQL 的 `ACCESS EXCLUSIVE` 等)。拿不到锁时,它会在锁队列里排队,而排在它后面的
所有普通读写都被它挡住——一条本该瞬间完成的 `ALTER TABLE` 可以演变成全站卡死。所以每条会拿强锁的
语句必须显式带超时,拿不到就快速失败,由重试解决,而不是无限排队:

```sql
SET lock_timeout = '3s';          -- 示例值:拿不到锁就放弃
SET statement_timeout = '60s';    -- 示例值:单条语句的总耗时上限
ALTER TABLE orders ADD COLUMN note text;
```

- 用 `SET LOCAL`(事务内)还是 `SET`(会话级)取决于迁移工具的事务模型;关键是**不依赖**连接池/角色的默认值。
- 超时值是示例,按表大小和业务容忍度定;重点是"显式写出来,评审时看得见"。
- 加性且只拿弱锁的语句(如 `CREATE TABLE`)也建议写,成本为零。

## 2. 需要 CONCURRENTLY 但工具在事务里跑

`CREATE INDEX CONCURRENTLY` 不能在事务块内执行。若迁移工具把整个文件包进事务,有两条路:

1. 工具支持"本文件不使用事务"的标注,就用它,并把该语句单独放一个迁移文件。
2. 否则迁移里只写普通 `CREATE INDEX IF NOT EXISTS`(小表/新库可接受),并在**文件头部注释**写明大表上线前的
   手工等价步骤:

```sql
-- online-note: 生产大表请先手工执行(不在事务内):
--   SET lock_timeout='3s';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_orders_user_id ON orders (user_id);
--   -- 之后核对 pg_index.indisvalid = true;若为 false,DROP 掉重建。
-- 本迁移随后的 IF NOT EXISTS 会因索引已存在而空转。
CREATE INDEX IF NOT EXISTS ix_orders_user_id ON orders (user_id);
```

要点:迁移必须幂等(`IF NOT EXISTS`),这样手工步骤先做、迁移后到都不冲突;`CONCURRENTLY` 失败会留下
`INVALID` 索引,所以手工步骤里要写清验证与清理方式。

## 3. 大表回填:分批 + 可续跑

一条 `UPDATE` 改全表会长事务、膨胀 WAL、拖住复制与 vacuum。写成分批、可中断续跑的形态:

```python
# Python (psycopg) —— 每批独立提交,以主键游标推进,重跑只处理剩余行
def backfill(conn, batch=5000):
    while True:
        with conn.transaction():
            cur = conn.execute(
                """
                WITH todo AS (
                  SELECT id FROM orders WHERE region IS NULL
                  ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED)
                UPDATE orders o SET region = 'unknown'
                FROM todo WHERE o.id = todo.id
                """, (batch,))
            if cur.rowcount == 0:
                return
        time.sleep(0.05)  # 给在线流量让路
```

```ts
// TypeScript (node-postgres) —— 同样的形状
async function backfill(pool: Pool, batch = 5000) {
  for (;;) {
    const { rowCount } = await pool.query(
      `WITH todo AS (SELECT id FROM orders WHERE region IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE orders o SET region = 'unknown' FROM todo WHERE o.id = todo.id`, [batch]);
    if (!rowCount) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
```

判据:**重跑安全**(WHERE 条件本身就是"还没做的行")、**每批有界**、**进度可观测**。大批量回填一般
不放进部署期迁移,而是独立脚本/任务;迁移里只留结构变更和"回填是否完成"的校验。

## 4. DROP 之前只读预览行数

破坏性迁移 apply 前,先只读列出"将被 DROP 的表现在有多少行",让执行人看到不可逆数据丢失的规模:

- 表名**只从待执行迁移的 SQL 解析**,不接受自由参数;标识符过白名单正则再用驱动的标识符引用函数拼接。
- 只读事务 + 短 `statement_timeout`;单表失败只记录结果,不影响整体退出码。
- 输出只含库名、表名、行数、文件名,不含连接串与行内容。
- 行数非 0 时,迁移头部必须能回答"数据去哪了"(已归档/已迁移/确认可丢),否则按 `irreversible` 处理。

## 5. Expand / contract 与滚动发布中的旧版本

滚动发布期间,**旧版本进程仍在运行**,并且会在新连接上继续做自己的启动期/连接期检查(权限矩阵比对、
schema 校验、ORM 元数据核对)。因此:

| 动作 | 放在哪 | 原因 |
| --- | --- | --- |
| 加表/加可空列/加索引/放宽约束/新增授权 | pre-deploy | 旧版本不会因"多了东西"而失败 |
| 收紧权限(REVOKE)、加严约束、删列、删表、改名 | **post-deploy**(所有新版本已上线之后) | 旧版本还在引用旧形态 |

收紧一个旧版本会校验的东西,要两步走:第一步发布新版本,让它同时接受"旧形态 + 新形态";第二步,
在 post-deploy 阶段执行收紧迁移;落地后再把"同时接受"的过渡声明删掉恢复严格。镜像回滚被禁止或
很慢时,窗口只能靠这个顺序来缩短,没有别的办法。

### 用线上版本自己的校验器验证候选迁移

人读 SQL 判断"旧版本会不会拒绝"不可靠。可靠做法是把**线上正在运行的那个提交**的校验器原样取出来
(例如 `git archive <线上 SHA> -- <校验器与矩阵路径>`),在临时目录加载,然后拿它去验证"候选迁移执行后"的
目录/ACL/schema:

1. 取出线上 SHA 的校验器及其数据文件;
2. 算出本次发布的待执行集 = 候选 manifest 里、线上 manifest 里没有的条目;
3. 对每个 pre-deploy 待执行项,静态归因到它触及的对象,构造"执行后"的预期状态;
4. 用线上校验器验证该状态,拒绝即阻断,并给出"改为两步走"的处置指引;
5. 反向再查一次:post-deploy 迁移执行前,新版本已上线——用候选自己的校验器验证"post-deploy 触及的
   对象仍是旧形态"是否被接受。

退出码语义固定为三态:兼容 / 有阻断项 / **无法评估**。取不到线上 SHA、线上校验器不可读、解析失败,
一律归为"无法评估"并**按失败处理**(fail closed),绝不当作"没发现问题"。

### phase 必须显式声明,不得静默默认

manifest 条目里的部署阶段(pre-deploy / post-deploy)如果允许缺省,且缺省被解析成 pre-deploy,
那么一条本应放在 post-deploy 的收紧迁移,会因为漏写字段而在旧镜像还在跑时提前执行——这正是真实发生过的
事故形态(见 [tutorial](../../../tutorial/06-codebase-architecture/migration-online-safety.md))。规则:

- 「激活序号」之后新增的每条迁移,phase 缺失即报错,不提供默认值;
- 解析器遇到未知/缺失值,抛错而不是回退;
- 带外部证据前置条件的迁移(例如"某依赖已下线才允许 DROP"),在登记表里声明"哪个 phase 才供得起这份证据",
  并用静态断言校验登记的迁移确实落在该 phase。

## 6. 可逆性声明与实际语句的静态交叉校验

`-- reversibility:` 只是声明,必须有检查器把声明和语句对照:

- 去掉注释、字符串字面量、`CREATE FUNCTION` 等函数体(它们在 apply 时不执行)、以及 `GRANT/REVOKE` 里
  作为权限名出现的 `TRUNCATE` 之后,扫描 `DROP TABLE` / `DROP COLUMN` / `TRUNCATE` / `DELETE FROM`;
- 声明 `forward-only` 却含这些语句 → 分类错误;
- 声明 `reversible` 且含破坏性语句 → 必须有 `undo/` 文件或 `-- down:` 块;
- 声明 `irreversible` → 必须有"为什么不可逆 + 补救方向"。

检查器自身坏掉(扫到 0 条迁移、登记文件解析失败、校验和漂移)必须无条件失败,不受"仅提示模式"影响——
坏掉的检查器不能看起来像"没有违规"。

### 新规则只约束激活序号之后的条目

引入新规则时,历史迁移不可改(已冻结校验和)。做法:

- 在 manifest 里登记一个**激活序号**(或"激活序号 ∧ 撰写时间"的合取),新规则只约束序号更大的条目;
- 历史条目的空洞(缺声明、缺 phase、含破坏性操作)**逐条登记**:校验和、操作清单、处置结论、恢复路径、
  以及为什么放行——写在外部登记表,而不是回头改冻结的 SQL;
- 激活判据只在一个模块里定义,各检查器导入它,不各写一份裸的 `sequence > N`。

## 7. 评审清单(线上安全部分)

1. 每条拿强锁的 DDL 有显式 `lock_timeout` / `statement_timeout` 吗?
2. 需要 `CONCURRENTLY` 的索引,头部写了大表手工步骤、迁移本身幂等吗?
3. 回填是分批、可续跑、每批有界的吗?
4. 有 DROP 吗?执行前能只读看到行数吗?
5. 收紧/删除类变更在 post-deploy 吗?phase 是显式写的吗?
6. 旧版本的校验器验证过候选迁移吗?无法评估时是失败吗?
7. 声明与实际语句通过交叉校验了吗?历史空洞有登记理由吗?
