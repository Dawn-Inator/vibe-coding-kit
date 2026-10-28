---
name: cross-service-event-contract
description: Use when adding, changing, routing, retrying, or debugging an asynchronous event handed off from one internally-owned service to another (an outbox/queue producer on one side, an intake/inbox consumer on the other) — event-type allowlists, aggregate identity and dedup keys, idempotency, and failure classification. Two services with no shared package silently drift unless this contract is enforced by a test that reads both sides.
---

# Cross-Service Event Contract

Use this skill for any asynchronous, at-least-once event handoff between two services that don't
share a code package (so there's no compiler to catch drift for you). This is a worked, complete
pattern from a real payments-to-growth-rewards event pipeline — adapt the concrete field/table names,
keep the structural rules.

## Why this needs its own discipline: two services, no shared package, no compiler

When Service A produces an event type and Service B consumes it, and the two share **no** common
package (by design — sharing one would require both sides' deploy images to carry declaration files
neither otherwise needs, and a missed copy step there turns into a boot-time crash, which is worse
than the silent-drop failure mode this contract manages instead), the two allowlists **will drift**
unless something actively checks them against each other. This is not a hypothetical: an
undetected-for-months split where six independently-described values had gone out of sync across
scattered documentation is the origin of the discipline below — consolidate the contract in one
place, then enforce it with a test, not a doc reading habit.

## The contract table: one place, not scattered across docs

Keep a single table — event type × aggregate type × aggregate-ID source × dedup/revision value ×
producer — as the canonical registration record for every event type that crosses the boundary. Every
new event type gets a new row here in the same change that adds its code. Scattering this
information across multiple documents is exactly how it silently goes stale; consolidate it, and let
every other document that mentions the contract point at this one table instead of restating it.

## Enforce allowlist parity with a bidirectional, source-reading test — not a one-sided literal comparison

The consistency of "both sides agree on which event types are routed" must be enforced by an
automated test, and it must be **bidirectional**: one test living in Service A's codebase that
statically reads Service B's actual source (not a copy, not a re-declared literal) to assert set
equality, *and* a mirror test living in Service B's codebase reading Service A's source the same way.

Why bidirectional and not one test in either side: the two services typically run in different CI
lanes/pipelines. A single one-sided test only catches drift when *that specific* lane happens to run
against the change — reasoning about "will that lane definitely run for this PR" is exactly the kind
of judgment call this kind of test exists to eliminate. Two independent tests, each triggered by its
own service's own lane, guarantee that whichever side changes, that side's own test catches a
mismatch immediately, with no dependency on the other lane also running.

Guard each of these tests against silently degrading into a no-op: if the source file it reads goes
missing, if the constant it looks for disappears, or if the expression shape it's parsing changes into
something it doesn't recognize, it should fail loudly — never fall back to an empty set that makes
a set-equality assertion vacuously, uselessly true.

A narrower test that only compares a service's own constant against a literal written in its own test
file is a different, weaker kind of test — it catches "the constant changed but the description of it
elsewhere in the same file didn't," which is still worth having, but it provides **zero** protection
against the actual cross-service drift this skill is about. Don't let a test like that stand in for
the real bidirectional, source-reading one.

## Dedup axis: pick the actual point of variance, not the coarsest key available

Deduplicate on the narrowest key that's actually guaranteed unique for your delivery semantics —
typically `(aggregate_id, event_type)`, not `aggregate_id` alone. Getting this wrong has a specific,
dangerous failure shape worth naming explicitly: if two different event types can legitimately share
one `aggregate_id`, and delivery can arrive out of order (no ordering guarantee across a queue is a
very common default), then deduping on `aggregate_id` alone means **whichever event happens to arrive
second silently looks like a duplicate of the first and gets dropped** — with the consumer still
returning a success response, so the producer believes delivery succeeded, and no error, retry, or
dead-letter entry is ever created. This is a *worse* failure than an outright rejection: it's silent
and permanent.

Confirm delivery is genuinely unordered before assuming this can't bite you (check whether the
consumer loop has any `ORDER BY` or equivalent — if it processes messages in whatever order the queue
handed them back, unordered delivery is real, not theoretical).

Layer a database-level `UNIQUE` constraint on the real dedup axis as a **backstop, not the primary
gate** — application-level "read the current high-water mark, then decide" logic has an unavoidable
check-then-act race window under concurrency that a `UNIQUE` constraint alone doesn't close (two
concurrent readers can both observe "no prior event yet" before either has written). Know explicitly
which layer is your actual gate versus which is the backstop, and don't leave the backstop's own
conflict-arbiter targeting so specific that it silently swallows a *different* kind of collision it
wasn't meant to guard — an unscoped conflict check that surfaces loudly as an integrity error, forcing
investigation, is often safer than a narrowly-targeted one that quietly no-ops on an unexpected
collision shape.

If your dedup/ordering key ever needs to become a genuinely monotonically-increasing revision number
(rather than a constant per event type, which sidesteps the whole ordering question today), revisit
this section — an increasing revision reopens exactly the race window described above, and the
correct fix at that point is a single conditional upsert keyed on the dedup axis with a "new value
must exceed the stored value" guard, not an advisory lock (locks don't compose well with an
aggregate/window query, and often can't be acquired at all on top of one).

## Width/length contracts chain across services — and prefixing breaks them

If an identifier flows through more than one service's schema and DTO validation, check that **every**
link in that chain shares the same maximum length, with **zero headroom** assumed anywhere. A common,
easy-to-miss mistake: a producer decides to prefix a shared identifier for readability/namespacing
(e.g. `sometype:<original-id>`) without checking that every downstream length constraint in the chain
was already sized exactly to the *un-prefixed* identifier's maximum length. The prefixed value then
silently overflows the tightest link in the chain on the longest legal identifiers only — passing
every test that happens to use a short example ID, and only failing in production once a long enough
identifier reaches it. Never add a prefix to an identifier that flows across a service boundary
without re-deriving the full width chain first; when in doubt, keep the identifier raw and put any
namespacing information in a different field instead of prefixing the identifier itself.

## New-event-type wiring checklist — treat it as one atomic change

Missing any one of these produces a **silent** drop or reject, not a loud error, so treat the whole
list as one atomic change, not a sequence you can partially land:

1. The producer's payload contract for the new event type — including any field the consumer requires
   non-optionally (a missing required field surfaces as a rejection on the consumer side, often as a
   generic parse error that doesn't obviously point back at "you forgot a field").
2. Add the event type to the producer's own outbound allowlist.
3. Add the event type to the consumer's own inbound allowlist.
4. Register the event's aggregate-type/aggregate-ID-source/dedup-or-revision value in the canonical
   contract table, and confirm the new value doesn't collide with an existing row's dedup axis.
5. Let the bidirectional set-equality test (above) be the thing that actually verifies steps 2 and 3
   agree — if it doesn't fail red when only one side is updated, it isn't wired correctly yet.

## Failure classification: only true payload/contract rejection is terminal

Classify delivery failures narrowly:

- A genuine payload/contract rejection (the receiving side's own validation says "this request is
  structurally wrong and resending it unchanged will never succeed") is the **only** category that
  should be treated as terminal (dead-lettered, archived, not retried).
- Everything else — authentication hiccups, routing/deployment-window blips, rate limiting, transient
  server errors — must be retryable.

The concrete failure this narrow classification exists to prevent: an earlier, broader "any 4xx is
terminal" policy meant that a single transient authentication-token rotation glitch, or a few minutes
of 404s during a routine deploy window, could **permanently dead-letter every event in flight during
that window** — turning a few-minute infrastructure blip into permanent data loss. Narrow the
terminal category to only the failure modes that resending genuinely can't fix, and make sure
visibility into "delivery is stuck" comes from monitoring/alerting on the retry queue, not from
letting events silently disappear.

## Silent-by-design still needs to be loud in observability

If your design deliberately doesn't throw/crash on an unregistered event type (a defensible choice —
one bad event type shouldn't be allowed to poison an entire ordered queue and block every legitimate
event behind it), that "don't crash the pipeline" choice must not also mean "don't tell anyone." Raise
the log severity high enough that it's actually noticed (not buried at a level nobody's dashboard
surfaces), attach a structured field for the specific event type that got dropped (not just a
human-readable message — you need to be able to query "which event type" after the fact, and a naive
logging call that only captures the log *template* rather than its interpolated values will leave you
unable to recover which value actually triggered it), and wire an alert threshold of **greater than
zero** — under correct operation this code path should never fire at all, so any occurrence is itself
the signal, not a rate to tune a threshold against.

## Idempotency needs depth, not one check

Layer independent idempotency mechanisms at each stage the event value passes through (a unique
constraint at the point of first-fact recording, a separate idempotency key at the outbox/queue-send
stage, another uniqueness constraint at the final side-effect/ledger stage). Each layer closes a
different concurrency window; relying on just one (especially just an application-level
check-then-act) leaves the others' windows open. When choosing what a downstream idempotency key
derives from, pick the axis that actually matches your concurrency risk — e.g. dedupe by the *user*
performing an action if two of that user's concurrent requests are the real risk, not by a
per-request ID that would let both concurrent requests race through independently. The question to
ask is "what shared value would legitimately race here", not "what ID happens to be handiest to key
on."

Prefer anchoring a critical one-time state fact (e.g. "has this actor already triggered this benefit")
to an explicit, independent fact-record — not to a broader mutable status field elsewhere in the
system that a differently-ordered side effect could flip before your check runs. A concrete failure
shape this avoids: if "did this succeed" is inferred from a status field that an unrelated, later
side-effect handler can also legitimately write (e.g. a cancellation notification that arrives out of
order and unconditionally writes its own status), a narrow window opens where the status briefly says
"succeeded" for an actor who in fact holds nothing — and any reward/benefit granted based on reading
that field at the wrong moment is now permanently, unrecoverably mis-issued, and the identity used to
prevent a second grant is now also permanently occupied by the wrong case.

## Be cautious about "clawing back" an already-issued side effect

Before implementing an automatic reversal for an incorrectly-granted one-time benefit, check whether
your reversal mechanism can create *more* damage than the original bug. A reversal implemented as an
independent negative ledger entry (rather than a true deletion of the original grant, which is often
deliberately how these systems are built, to preserve an audit trail) combined with a "grant this
exactly once per actor" uniqueness constraint can mean: after a reversal, the actor's slot for that
one-time benefit is **permanently and irrecoverably consumed** — even a fully legitimate re-earn of
the same benefit later can never be granted again, with no administrative path to reissue it. Treat an
automatic clawback of an irreversible one-time grant as a product decision requiring its own explicit
sign-off, not a routine bugfix — and document the conditions under which it should be revisited (e.g.
if the benefit becomes redeemable for something of real value, or if abuse patterns are actually
observed), rather than silently deciding "never" forever.

## "不丢弃"不等于"平坦无限重试"

给事件打上 never-dead-letter(绝不进死信)标记,只解决"不丢",并不会自动给你退避、状态和告警——
关掉按次数判死之后,默认行为恰恰是以固定间隔无限热重放、行上无痕迹、没人被叫醒。规则:

- 凡注册 never-dead-letter 的事件,**必须同时配**:失败写到事件行、指数退避(带上限)、`parked` 状态
  (连续失败超过示例阈值后进入,仍可重试)、`parked_count` / `oldest_parked_age_seconds` 指标与告警。
- **`parked` 与 `dead_letter` 分开计数**:不丢弃事件的 `dead_letter_count` 恒为 0,以它为 key 的告警永远不响。
  `parked` 路径不得写 `dead_letter`。
- 退避只给不丢弃的事件;给普通事件加退避会让毒消息永远判不了死。
- **告警用到的字段必须在日志/指标索引里声明**,否则告警查询永远 error/空,而没人知道它没在工作。
- 用一个**类级测试**枚举全仓所有注册点(排除测试文件、断言发现集合非空),逐个断言配套设施存在,
  防止新注册者照抄旧的错误配置。

细则、骨架与事故推理见 [references/never-dead-letter.md](references/never-dead-letter.md) 与
[教程](../../tutorial/06-codebase-architecture/migration-online-safety.md)。

