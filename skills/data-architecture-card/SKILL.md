---
name: data-architecture-card
description: Use before creating or materially changing a persistent store — a new table, materialized view, queue, logical database, external sink, or cross-database projection; changing an existing store's retention, capacity boundary, or database/partition/shard placement.
---

# Data Architecture Card

新建一张表很容易,但"这张表归谁管、放哪个库、预期能长多大、什么时候该清理、多大流量该重新评估"这些
问题经常没人想清楚就先建了——等真出问题时,已经是几百万行数据摆在那,谁也不敢动。这个 skill 强制
在建表/建队列/建物化视图之前,先把这几件事写成可核对的字段,而不是留在某个人的脑子里。

## 什么时候必须填卡

命中下面任意一条,建表/迁移之前必须先填卡:

- 新建 PostgreSQL 表、物化视图或队列。
- 新建逻辑数据库、外部日志/指标 sink,或者跨库投影。
- 新建日志、指标、事件流、审计、outbox/ledger、分析 mart、快照等持续化存储。
- 把已有存储改成无界追加,或者修改它的保留策略,或者改变数据库/分区/分片边界。

**可以声明"不适用"的情况**:只新增索引、只 ALTER 已有对象、只做 seed/backfill/repair,且不创建
任何新持久化对象的迁移。**`CREATE TABLE`、`CREATE MATERIALIZED VIEW`、创建队列这三类操作,不能
声明"不适用"**。纯读取的查询/投影逻辑变更(比如给查询加一个可见性过滤条件)本身不构成新的持久化
权威,不需要为它伪造一张卡。

**不要因为现有连接/迁移工具/ORM 最容易复用,就默认把新数据放进最方便的那个库**。这份规范也不要求
每个新系统都拆库或分表——继续用现有库和单表完全可以,**但前提是先留下可验证的定量决策和重评阈值**,
不能什么都不写就默认塞进去。

## 卡片与验证

准备 Card 前读取项目的当前数据治理真源。按本次需要读取 [Card 契约](references/card-contract.md)：
必填字段、放置判据、容量与保留、一致性、重评阈值、物理设计及健康结论。项目的注册表、迁移和
环境证据由项目扩展指定；不能以文档或静态结果冒充线上数据。

新业务边界先走 [business-boundary-cards](../business-boundary-cards/SKILL.md)，迁移按
[migration-downpath](../migration-downpath/SKILL.md) 执行。
