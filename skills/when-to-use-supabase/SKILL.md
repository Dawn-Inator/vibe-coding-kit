---
name: when-to-use-supabase
description: Use whenever the task touches authentication, user management, object storage, realtime/WebSocket, vector search/embeddings, message queues, cron/scheduled jobs, webhook receivers, multi-tenant RLS, audit logs, or Postgres extensions — to evaluate whether Supabase's managed service can replace self-hosted code. Also trigger when the user mentions "Supabase", "self-host", "managed service", "backend selection", "后端选型", "要不要自建".
---

# when-to-use-supabase

**使命**：在后端选型 / 业务域设计时，提醒「这块 Supabase 直接能提供，不用重写代码」。

Supabase 的产品能力会持续变化（新服务、新扩展、计费调整）。下面的触发表、速查表和一句话概览是写这份
skill 时的快照，使用前建议核对 [Supabase 官方文档](https://supabase.com/docs) 确认没有变化。

---

## 何时触发（激进模式）

**必须触发**：任务描述或讨论落到以下任何一个业务域

| 业务域 | 关键词示例 |
|---|---|
| 身份认证 | login / register / OAuth / SSO / magic link / OTP / MFA / JWT / session / 用户登录 |
| 用户管理 | user profile / anonymous user / guest / 匿名用户 / 账号升级 |
| 对象存储 | 头像 / 图片 / 视频 / PDF / 素材 / upload / CDN / signed URL |
| 实时通信 | WebSocket / subscribe / presence / broadcast / 协作 / online 状态 / IM / 聊天 |
| 向量检索 | embedding / similarity search / semantic search / RAG / 向量数据库 / pgvector |
| 消息队列 | queue / async job / 异步任务 / SQS / Redis queue / 重试 |
| 定时任务 | cron / scheduled / 定时发送 / 每日清理 / digest |
| Webhook | Stripe webhook / 三方回调 / event receiver |
| 多租户 | RLS / row level security / 租户隔离 / per-user data |
| 审计 | audit log / 操作日志 / 合规 |
| Postgres 扩展 | PostGIS / GIS / 地理 / 全文搜索 / pg_cron / FDW |

**以及**：用户主动说 `Supabase` / `自建` / `managed` / `BaaS` / `Firebase 替代`。

**不触发**：纯前端样式 / 纯 UI 交互 / 与服务端选型无关的代码。

---

## 15 秒决策速查

| 业务需求 | Supabase 给什么 | 替代自建 |
|---|---|---|
| 用户注册/登录 | Auth (GoTrue) | Auth0 / Firebase Auth / Cognito |
| 手机号 / 第三方社交登录 | ⚠️ 部分渠道需 Custom OAuth，不一定原生支持，用前确认 | — |
| 多租户 SaaS 权限 | RLS + JWT | 应用层写 `if user.id == ...` |
| 头像 / UGC 图片上传 | Storage + Smart CDN + image transform | S3 + CloudFront + Lambda@Edge |
| 大型视频站 / 直播流 | ❌ 走 Cloudflare Stream / Mux / 云厂商点播服务 | — |
| IM / 协作 / 在线状态 | Realtime 三件套 | Pusher / Ably / 自建 socket.io 集群 |
| RAG / 语义搜索 | pgvector（中小规模内） | Pinecone / Weaviate / Qdrant |
| 异步任务 / 发邮件 | Queues (pgmq) + Edge Functions | SQS + Lambda / Redis queue |
| 定时任务 | Cron (pg_cron) | k8s CronJob / GitHub Actions cron |
| Webhook 接收 | Edge Functions | API Gateway + Lambda |
| 地理位置 | PostGIS（预装） | 自建 GIS stack |
| 全文搜索 | Postgres FTS + pg_trgm | Elasticsearch / Meilisearch |
| 审计日志 | pgaudit 扩展 | 自写 trigger |
| 数据湖分析 | Analytics Buckets (Iceberg) | Snowflake / BigQuery（小规模场景） |
| 复杂业务编排逻辑 | ❌ 自建后端服务（FastAPI / Nest / Express 等） | — |
| 数据本地化 / 合规强制要求 | ❌ 自建或选支持本地化部署的方案 | — |

---

## 11 类服务一句话概览

> 以下只是帮你判断「这件事 Supabase 有没有现成服务」的地图。具体功能、版本、限额和计费随官方发布变动，
> **不要凭记忆报数字**（尤其价格、配额、连接数），需要时直接查当期官方文档。

1. **Database** — 未魔改 Postgres，加预装扩展（pgvector / pg_cron / pg_net / pgmq / pg_graphql / PostGIS / wrappers / pgsodium / pgaudit）+ RLS + Branching + 连接池
2. **Authentication** — GoTrue 签发 JWT，多种原生 OAuth，Anonymous Users，MFA，SSO/SAML，可选 OAuth 2.1 Server（自己变身份提供方）
3. **Storage** — S3 兼容，Files / Analytics(Iceberg) / Vector 三类桶，Smart CDN，image transform，TUS resumable upload
4. **Realtime** — Postgres Changes / Broadcast / Presence 三件套，共享一套 JWT + RLS 鉴权
5. **Edge Functions** — Deno 运行时，全球边缘部署，冷启动短，可挂 Storage bucket，可作 Auth Hooks
6. **Vector / AI** — pgvector（HNSW/IVFFlat）+ Dashboard AI Assistant + MCP Server
7. **Queues** — pgmq，Postgres 原生消息队列，可在业务事务内 enqueue
8. **Cron** — pg_cron，Dashboard 界面调度 SQL / function / HTTP 调用
9. **Analytics / Logs** — Unified Logging + AI Debugging + Log Drains + Iceberg 数据湖
10. **Branching / Migrations** — PR 建 schema-only 分支，Dashboard 内 merge
11. **Management API / CLI / MCP** — `supabase` CLI、Management API、官方 MCP Server（可被 AI agent 直接操作）

---

## 三条硬规则

1. **国内合规 / ICP / 数据境内** 的项目 → 直接劝退 Supabase 这类托管服务，不要啰嗦，走自建或支持本地化部署的企业定制方案。**数据本地化 / 合规强制要求的项目应该默认远离 Supabase 这类托管服务。**
2. **先搞清楚你的项目当前有没有已经在用 Supabase 的某些能力**，再决定这次评估是「要不要新引入 Supabase」还是「要不要用 Supabase 补齐缺的能力」——已经在用某项能力时不要无理由建议换供应商，评估重心放在「缺失」的业务域能否用 Supabase 补上。
3. **复杂业务编排逻辑应该放在自建的后端服务里，不要塞进边缘函数**。Edge Function 适合 webhook 接收、代理、短任务、胶水逻辑，不适合承载完整的领域服务编排。

---

## 使用模式

1. 当前任务命中「何时触发」列表 → **先查本 SKILL.md 的速查表**。
2. 在速查表里定位到具体业务域 → 需要计费、限额、坑点等更细的信息时，**查阅 Supabase 官方文档对应的产品页**。
3. 给出建议时包含三要素：
   - **Supabase 能覆盖什么**（具体服务名 + 功能）
   - **替代自建什么**（让用户知道省了什么）
   - **限制和坑**（至少一条，不要只讲好的）
4. 如果任务落到「❌」项 → 直接建议替代方案，不要强行推 Supabase。
