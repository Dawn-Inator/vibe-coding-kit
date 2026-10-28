# 服务骨架:三种语言的目录映射

同一骨架(`api` / `service` / `core` / `provider` / `database` / `bootstrap`)在不同语言里的落地。
名字可以换,**依赖方向与禁止项**不能换。

## Python (FastAPI)

```
app/
  api/                 路由装配、鉴权策略、版本清单
  service/<domain>/<module>/<object>/
      router.py router_internal.py model.py service.py
      query.py projection.py assembler.py operate.py facade.py mixin.py
  core/                response/ exception/ pagination/ outbox/ idempotency/ blocking.py internal_gateway/
  provider/            ports/ composition/ adapters/<vendor>/
  database/<store>/<table>/   model.py operate.py facade.py
  bootstrap/           lifespan.py readiness.py worker_main.py
```

机器强制:`backend-check`(依赖环、槽位读写、ORM 泄漏、vendor SDK 位置)+ 项目自有的 import 规则:
`core|provider|database` 不得 `from app.service|app.api import ...`。

## Node (NestJS / Express)

```
src/
  api/                 controllers 装配、guards、版本前缀
  service/<domain>/<module>/<object>/
      controller.ts(= router) dto.ts(= model) service.ts query.ts projection.ts
      assembler.ts operate.ts facade.ts
  core/                response/ errors/ pagination/ outbox/ idempotency/ blocking/ internal-gateway/
  provider/            ports/ composition/ adapters/<vendor>/
  database/<store>/<table>/   entity.ts operate.ts facade.ts
  bootstrap/           main.ts lifecycle.ts readiness.ts worker.ts
```

NestJS 里 module 文件只做装配,放在 `api/` 或各对象目录的 `*.module.ts`;禁止 `core|provider|database`
下出现指向 `service|api` 的 import,可用 ESLint `no-restricted-imports` 或 dependency-cruiser 的
`forbidden` 规则强制;跨 domain 只允许 import 对方的 `facade.ts` / `contract.ts`。

## Go

```
cmd/<svc>/main.go                       装配与进程入口
internal/
  api/                                  handler 装配、中间件、鉴权策略
  service/<domain>/<module>/<object>/   一个 package;导出符号即对外 API
      handler.go dto.go service.go query.go projection.go operate.go
  core/                                 response errors pagination outbox idempotency blocking
  provider/{ports,composition,adapters/<vendor>}/
  database/<store>/<table>/             model.go operate.go facade.go
  bootstrap/                            lifecycle readiness worker
```

Go 没有"只能 import 某个文件"的机制:用 package 边界 + 小写未导出符号表达私有,用 `internal/` 阻止
外部引用,依赖方向由 `go list -deps` 或 `depguard`/`go-arch-lint` 之类工具核对(或用 `backend-check`
的 Go 分析器)。跨 domain 只导入对方的 facade package 或 contract package。

## 写操作两级示例

```python
# database/pg/invoice/operate.py —— 表级通用写, 无业务规则
async def insert_invoice(session, row: InvoiceRow) -> InvoiceRow: ...

# service/billing/invoice/operate.py —— 带规则的写, 跨表事务
async def issue_invoice(session, cmd: IssueInvoice) -> InvoiceDto:
    check_credit_limit(...)                  # 业务规则
    row = await insert_invoice(session, ...)  # 复用表级写
    await outbox.enqueue(session, event)      # core 能力
```

```ts
// database/pg/invoice/operate.ts
export const insertInvoice = (tx: Tx, row: InvoiceRow) => tx.insert(invoice).values(row);
// service/billing/invoice/operate.ts
export async function issueInvoice(tx: Tx, cmd: IssueInvoice) { checkCreditLimit(cmd); /* ... */ }
```
