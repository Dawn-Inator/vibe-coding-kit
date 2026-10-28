# Response Envelope, Pagination, Error Codes

## Unified envelope, declared per route

- One response envelope for every public route, e.g. `{ code: int, data: T | null, message: string }`
  with `code == 0` meaning success. Success and failure share the same outer shape so clients write
  one parser.
- **Every route declares its response model** (`response_model=Envelope[Dto]` or the framework
  equivalent). Without it the generated schema says "any", and generated client types lose their
  value. A checker walks routes and flags any without a declared envelope model, plus routes that
  declare an overly wide payload type.
- Existing violators go into a **baseline that may only shrink** (a CI step fails if the baseline file
  grows relative to the base branch). New routes never enter the baseline.

```python
class Envelope(BaseModel, Generic[T]):
    code: int
    data: T | None = None
    message: str = "ok"

@router.get("/order/list", response_model=Envelope[PaginatedData[OrderDto]])
async def list_orders(...): ...
```

```ts
interface Envelope<T> { code: number; data: T | null; message: string }
interface Paginated<T> { items: T[]; total: number | null; nextOffset: number | null; nextCursor: string | null }
```

## One pagination shape

Pick one shape (items + total + next pointer), one casing, and one cursor-vs-offset rule, and use it
everywhere. Counter-example worth remembering: a codebase that exposed **both** a snake_case page
payload (`next_offset`) and a camelCase one (`nextOffset`) for the same API family. Every consumer
needed two parsers, generated types disagreed with runtime output, and a "paginated" helper in one
layer was silently incompatible with another. The cheapest time to prevent this is the first
paginated endpoint; afterwards, add a guard that rejects a second pagination model and a test that
compares the runtime payload's key casing to the schema's.

## Error codes

- **Segmented code.** A fixed-width integer whose leading segment mirrors the HTTP class and whose
  trailing segment subdivides by domain, e.g. `{http:3}{domain:2}` -> `40001`, `40901`. Keep the
  domain-segment allocation table next to the constants.
- **Never reuse a code point.** Retired meanings stay retired; a reused number makes old client
  builds mis-handle new failures. A test can snapshot the set of assigned codes and fail on any
  removal or semantic change.
- **Domain codes for distinguishable failures.** If the caller must behave differently (show a
  "balance too low" sheet, offer a retry, prompt re-login), the server must return a dedicated domain
  code. A bare `400`/`409` forces clients to parse message text, which is neither stable nor
  localisable.
- **Unknown exceptions**: one catch-all handler returns HTTP 500 with a generic message and a request
  id header; the exception text, stack, SQL and provider payloads go to logs only. Domain-deterministic
  rejections are 4xx (a conflict is 409, not 500), and upstream dependency failures are 503 with
  `Retry-After` where meaningful.
- **Request-validation errors**: log the failing field locations and error types (never the input
  values) for internal routes, where nobody can otherwise tell why a peer service was rejected.

```python
@app.exception_handler(Exception)
async def handle_unknown(request, exc):
    log.exception("unhandled", request_id=request.state.request_id)   # details here only
    return JSONResponse(status_code=500, content=fail(ErrorCode.INTERNAL_ERROR, "internal error"))
```

```ts
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err, requestId: req.id }, "unhandled");              // details here only
  res.status(500).json({ code: 50000, data: null, message: "internal error" });
});
```
