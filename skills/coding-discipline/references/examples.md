# 编码纪律正反例

示例按规则编号组织(见 [SKILL.md](../SKILL.md) 的规则清单)。语言只是载体,原则相同。

## R1 / R2 / R3:构造期校验依赖

反例(Go):每个方法都自查一遍,还用反射防 typed nil。

```go
func (r *Runtime) Load(ctx context.Context, id string) (Order, error) {
	if r == nil || r.store == nil || ctx == nil || ctx.Err() != nil || missing(r.cache) {
		return Order{}, ErrConfig
	}
	return r.store.Load(ctx, id)
}
```

正例:构造函数是唯一的校验点,方法里直接用。

```go
func NewRuntime(store Store, cache Cache) (*Runtime, error) {
	if store == nil {
		return nil, errors.New("runtime: store is required")
	}
	if cache == nil {
		return nil, errors.New("runtime: cache is required")
	}
	return &Runtime{store: store, cache: cache}, nil
}

func (r *Runtime) Load(ctx context.Context, id string) (Order, error) {
	return r.store.Load(ctx, id)
}
```

TypeScript 同理:构造函数参数用非可选类型,方法里不写 `if (!this.client) return`。
Python:`__init__` 里校验,方法里不写 `if self._db is None`。

## R4:错误可区分

反例:十种失败原因都变成同一个哨兵,线上只能看到"config error"。

```go
row, err := tx.QueryContext(ctx, q)
if err != nil {
	return ErrUnavailable
}
```

正例:包装保留原因;调用方需要分支时用 `errors.Is` 判断专门的哨兵。

```go
err := tx.QueryRowContext(ctx, q, id).Scan(&subject)
if errors.Is(err, sql.ErrNoRows) {
	return ErrSubjectNotFound // 调用方会据此返回 404
}
if err != nil {
	return fmt.Errorf("query subject guard %s: %w", id, err)
}
```

边界层(RPC/HTTP handler)负责把内部错误映射成对外状态码;映射前记录带原因的日志。对外隐藏细节
是边界的职责,不是每一层都把原因抹掉的理由。

## R5 / R6:横切关注点进拦截器

反例:每个 handler 开头都是同样的几行。

```go
func (h Handler) Get(ctx context.Context, req *pb.GetRequest) (resp *pb.GetResponse, err error) {
	if rpcidentity.ServiceID(ctx) != "gateway" {
		return nil, status.Error(codes.PermissionDenied, "caller denied")
	}
	defer func() {
		if recover() != nil {
			resp, err = failure(UNAVAILABLE), nil
		}
	}()
	// ...
}
```

正例:一个拦截器按方法表授权、恢复 panic 并记录堆栈;handler 只写业务。

```go
grpc.NewServer(grpc.ChainUnaryInterceptor(
	interceptors.Recover(logger),
	interceptors.AllowCallers(map[string][]string{
		"/f1.account.v1.Audience/GetMyAudience": {"gateway"},
	}),
))
```

HTTP 中间件、Express/Koa/Nest 拦截器、FastAPI 依赖同理。

## R7:宽容读

反例(服务内部 RPC):

```go
if len(req.ProtoReflect().GetUnknown()) != 0 {
	return failure(INVALID), nil
}
```

上游新增一个字段、先于下游发布,所有请求都会被拒。滚动发布期间新旧版本必然混跑。

反例(前端):

```ts
const keys = (v, expected) => Object.keys(v).length === expected.length && expected.every((k) => k in v);
if (!keys(result.data, ['id', 'name', 'active'])) throw new ApiError('unknown');
```

后端加一个字段,前端整页报错。正例:信任生成的类型,只检查自己用到的字段与判别字段。

```ts
const result = await request<AccountListSuccess>('/admin/v1/accounts');
if (result.code !== 0) throw new ApiError(result.code);
return result.data.items; // 多出来的字段无害
```

确需严格的场景(公网入口防参数污染、签名覆盖的结构),在边界一处配置拒收,并在契约里写明原因。

## R8:不校验自己的输出

反例:`snapshot, err := h.Query.Get(ctx, token)` 之后又 `ValidateSnapshot(snapshot)`。Query 是本服务
代码,它返回的就应该是合法快照;不合法是 Query 的 bug,应该在 Query 的测试里抓住,而不是在每个
调用方再验一遍、再静默降级成 UNAVAILABLE。

## R9:就绪探针轻量

反例:readiness 每次被调用都逐分片验库、生成 trace、发两次远程 health RPC。探针被频繁调用,下游
一抖动就把本服务摘掉,形成级联。

正例:后台循环定期刷新依赖状态写进原子变量;readiness 只读这个变量。深度自检在启动时做一次,
或提供独立的诊断命令。

## R10 / R11:组装根要薄,生命周期复用

反例:`Server` 结构体 170 个字段,每个后台功能都有自己的 `xxxMu / xxxCancel / xxxDone / xxxStopped`,
组装包直接 import 数据库包写 SQL。

正例:

```go
type Worker interface {
	Run(ctx context.Context) error
}

type Lifecycle struct{ /* 统一的 start/stop/drain,一处实现 */ }

func (l *Lifecycle) Go(name string, w Worker) { /* ... */ }

// bootstrap 只连线
mail := maildelivery.NewWorker(mailStore, mailClient, cfg.Mail)
lc.Go("mail-delivery", mail)
```

功能的适配器(把 A 服务的 store 接成 B 接口)放在功能自己的 adapter 包,组装根只调用构造函数。

## R12:条件可读

反例:

```go
if s == nil || s.adReward == nil || !s.adReward.running.Load() || ctx == nil || ctx.Err() != nil ||
	s.registrationFlow == nil || s.registrationFlow.Probe(ctx) != nil || len(s.targets) == 0 {
	return false
}
```

正例:删掉 R1/R2 能消除的项,剩下的用具名谓词表达意图。

```go
if !s.adReward.Running() || !s.registrationFlow.Healthy() {
	return false
}
```

## R14:按行为命名

| 反例 | 正例 |
| --- | --- |
| `closure_v11_fantasy_cors_test.go` | `fantasy_cors_test.go`,测试名 `TestFantasyRejectsUnlistedOrigin` |
| `crypto035_mux_v25_test.go` | `crypto_binding_routes_test.go` |
| `// W70 在既有 client 增加 ...` | `// ListPersonalMail returns at most 50 items; cursor is opaque.` |

任务编号放在提交信息和 history 里,不放进文件名与注释。
