---
name: object-storage-layout
description: Use when designing or changing OSS/S3-compatible bucket separation, environment isolation, object-key directories, storage retention or public/private delivery. Provides reusable bucket and key templates; provider SDK implementation belongs to provider-gateway.
---

# Object Storage Layout

设计或调整对象存储的 bucket、环境隔离、目录前缀、保留期与访问方式前，读取
[分桶与目录规范](references/layout.md)。适用于阿里云 OSS、S3 及兼容服务；不要求选定某个厂商。

先按访问权限、生命周期、环境和责任边界决定分桶，再按业务语义决定对象 key。
文件夹前缀本身不是安全边界；共享桶只有在身份策略和发布路径能落实隔离时才成立。
具体 bucket、前缀、CDN 域名及共享例外登记到项目配置／IaC 和存储清单，不能只留在聊天里。

存量 bucket 和 URL 的变化涉及迁移，不能因为采用本模板自动搬迁、删除对象、改变公开权限
或改生命周期。凭证与 SDK 边界遵循 [provider-gateway](../provider-gateway/SKILL.md)，
公开域名遵循 [domain-boundary](../domain-boundary/SKILL.md)，通用云资源命名遵循
[repository-layout](../repository-layout/SKILL.md)。
