# 域名命名与环境映射

这是新项目的默认模板。已有项目保留已登记的公开契约；采用不同方案时记录映射和理由，
不要为套用模板自动改 DNS 或迁移线上入口。以下 `example.com` 仅为产品域名占位符。

## 服务名与环境前缀

默认使用 `[<环境>-]<入口角色>.<产品域名>`：prod 省略环境，其他环境使用短横线前缀。

| 入口角色 | prod | stg | dev |
| --- | --- | --- | --- |
| 用户 API | api.example.com | stg-api.example.com | dev-api.example.com |
| 管理 API（确有独立入口时） | admin-api.example.com | stg-admin-api.example.com | dev-admin-api.example.com |
| Web | www.example.com | stg-web.example.com | dev-web.example.com |
| 管理后台 | admin.example.com | stg-admin.example.com | dev-admin.example.com |
| 移动网页／预览 | mobile.example.com | stg-mobile.example.com | dev-mobile.example.com |
| 媒体 CDN | cdn.example.com | stg-cdn.example.com | dev-cdn.example.com |
| 视频分发（独立服务时） | video.example.com | stg-video.example.com | dev-video.example.com |
| 下载（独立分发时） | download.example.com | stg-download.example.com | dev-download.example.com |
| 托管认证／数据入口（确有需要时） | auth.example.com | stg-auth.example.com | dev-auth.example.com |

- 只创建实际需要的入口；不因后端多了一个内部 service 就新增公网子域。共用 API 网关时继续用 api。
- 根域可承载官网或重定向至 www；由项目选定 canonical host，避免两个入口各自维护不同内容。
- sandbox 可用 sbx 前缀；临时预览如需产品域名，用 pr-<编号>-<角色> 并登记到期清理。
- 默认不混用 dev-api、api-dev、api.dev 三套方案。例外须在项目映射表显式声明。
- 如共用下载域／认证入口，登记共享范围及隔离机制；不要仅凭域名推断运行环境。
- 自定义域能力受供应商限制的第三方入口，按现有 domain-boundary 的第三方来源规则登记；
  不得为了表格齐全伪造 auth 子域或误把它当已支持的代理入口。

## 项目必须登记的事实

在项目自己的域名文档和配置源登记：入口角色、环境、完整 hostname、公开或内部用途、
DNS 目标、TLS 终止点、运行时配置键、OAuth/深链接回调路径、责任人及共享例外。
密钥值不进入此表。配置或 IaC 是机器读取的真源，文档引用它，不另维护一套会漂移的配置。
分支名与环境名的映射遵循 repository-layout，不能把 develop 拼成 develop-api。

## 变更验收

检查对应环境的 DNS、证书覆盖、路由、回调 allowlist、CSP 与客户端配置；验证产品域名的
实际请求及跨环境隔离。供应商原始地址返回 200 不能代替产品域名验收。
新规范的采纳不自动授权 DNS、证书、生产环境或存量 URL 变更。
