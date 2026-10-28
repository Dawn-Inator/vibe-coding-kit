---
name: data-erasure-boundary
description: Use when implementing or changing account deletion, privacy erasure, or data-subject deletion, or when adding a persistent table that holds personal data — defines the per-domain erase_for_user contract, transaction ownership, shared-row handling, external-object handoff, and required erasure declarations.
---

# Data Erasure Boundary(账号注销 / 隐私删除边界)

注销账号看起来是"把这个用户的数据删掉",实际有四个陷阱:谁持有事务、会不会误删别人共享的行、外部对象
(文件)谁来回收、新表加进来后有没有人记得处理。这份规范把它们固定成一套契约。

## 1. 统一签名:每个域一个 erasure 入口

每个持有个人数据的业务域,对外只暴露一个擦除函数,签名统一:

```python
# Python (SQLAlchemy async)
async def erase_for_user(session: AsyncSession, *, subject_id: str) -> ErasureResult: ...
```

```ts
// TypeScript
export async function eraseForUser(tx: Transaction, args: { subjectId: string }): Promise<ErasureResult>;
```

- `subject_id` 是**规范化的主体标识**(调用方已解析好);入口先校验"非空、无首尾空白",不合格直接抛错,
  不要在域内猜测或模糊匹配。
- 返回结果含各类动作的**受影响行数**(键名与语句一一对应,不得错位——审计按键读取)和需要外部回收的对象键。
- 域门面(facade)只转发到域内实现,上层协调器只依赖这个入口,不穿透到域内的表和语句。

## 2. 协调器拥有事务,域内函数不提交

- 账号注销协调器开启事务,依次调用各域的 `erase_for_user`,全部成功后**由协调器提交**;任一域失败整体回滚。
- 域内函数**不得** `commit` / `rollback` / 开新事务(可 `flush`),也不得做外部 I/O(调用第三方、发消息)。
- 需要"先读后写"的域,先用只读的 plan 函数选出目标集合,再执行写入,且两者共用同一套选择逻辑,避免读写
  口径漂移。

## 3. 只解除本人引用,不删除他人共享行

擦除的范围是"属于本人或标识本人的数据",不是"和本人有关的所有行":

| 数据形态 | 处理 |
| --- | --- |
| 本人创作的内容(自己发的消息) | 删除(含其子表:提及、翻译、收藏等) |
| 对方持有的行里**引用**本人的列(审核人、禁言操作人、最后编辑人) | 置空该引用,保留行 |
| 双方共享的会话/成员关系(对方的消息、对方的成员行、群内容) | **保留**,仅移除本人那一行 |
| 带自由文本、可能暴露本人的字段(举报详情) | 置空/匿名化该字段,行保留 |
| 以本人标识作主键/键值的派生标识 | 重新生成不含本人标识的键(rekey),或替换为匿名占位 |

判据:**这行如果删掉,会不会让另一个仍存续的主体失去他应得的数据?** 会 → 保留并只解除引用。

## 4. 外部对象:只返回 key,交给存储 owner

数据库里的行指向对象存储里的文件时:

- 擦除函数**不直接删对象**(它不是存储的 owner,也不该在数据库事务里做外部 I/O);
- 它收集这些行的对象键,去重排序后放进返回值;
- 事务提交后,协调器把 key 交给**存储 owner** 的回收流程(自带重试、幂等、对账);
- 事务回滚则 key 作废,文件不动——不会出现"行还在文件没了"。

## 5. 每条破坏性 DML 都要带 WHERE 且绑定主体参数

擦除代码里最危险的一行是漏了 `WHERE` 的 `DELETE`/`UPDATE`。用不需要真库的单元测试钉住"语句形状":

1. 用假 session 记录擦除函数发出的**每一条** DML;
2. 断言每条 `DELETE`/`UPDATE` 都有 `WHERE`,且范围引用了主体参数(或由主体派生的 id 集合);
3. 断言返回计数的每个键取自**语义对应**那条语句的 rowcount,而不是相邻语句;
4. 断言"没有本人消息时,依赖消息 id 集的可选语句一条都不发,对应计数为 0"。

```python
@pytest.mark.asyncio
async def test_every_dml_is_scoped_to_subject():
    session = RecordingSession(rows=...)
    await erase_for_user(session, subject_id=SUBJECT)
    for sql, params in session.dml:
        assert re.search(r"\bWHERE\b", sql), sql
        assert SUBJECT in params.values() or "IN (" in sql, sql   # 绑定主体或其派生集合
```

```ts
test('every destructive statement is scoped to the subject', async () => {
  const tx = new RecordingTx();
  await eraseForUser(tx, { subjectId: SUBJECT });
  for (const { sql, params } of tx.dml) {
    expect(sql).toMatch(/\bWHERE\b/i);
    expect(params.includes(SUBJECT) || /\bIN \(/i.test(sql)).toBe(true);
  }
});
```

真实删除效果(别人的行还在、本人的行没了)另用真库集成测试覆盖(见
[test-database-isolation](../test-database-isolation/SKILL.md))。

## 6. 新增持久化表必须声明 erasure 处理方式

建表/新增存个人数据的列时,在评审材料里(数据架构卡的保留策略旁)**必填**一项:

| 处理方式 | 要写清楚 |
| --- | --- |
| 删除 | 哪个域的 `erase_for_user` 负责、按哪一列定位主体 |
| 匿名化 | 哪些列置空/替换、替换后是否还能关联到主体 |
| 保留 | **法定理由**(如财务/审计留存期限)与到期后的处理,以及保留期内如何限制访问 |

缺这一项视为设计未完成。静态守卫:枚举全部带主体标识列的表,要求每一张在"erasure 登记"里有条目,
并由测试验证登记的入口确实触及该表;新表没登记 → 失败。

## 与其它 skill 的关系

存储的保留策略(热/总保留天数、到期动作)在 [data-architecture-card](../data-architecture-card/SKILL.md)
中声明,erasure 声明与之互补:前者回答"数据多久后按计划删",后者回答"主体要求删除时怎么办";两者冲突
(例如法定留存)时,以"保留并写明理由"显式记录。建表迁移走
[migration-downpath](../migration-downpath/SKILL.md)。
