# Rule Assumptions And Retirement

Read when a model generation changes for the orchestrator or a worker tier, when a red line seems to cost
more than it protects, or before adding a new orchestration rule.

Every orchestration rule encodes an assumption about what agents do not do reliably on their own. Rules
learned from incidents accumulate; without a review path they outlive the behavior they guarded against and
keep costing context and attention. This page records each red line's assumption so it can be checked
against current behavior instead of kept or dropped by feel.

## Red lines and their assumptions

"Trial" says whether the rule may be relaxed in a bounded trial. Rules guarding money, security boundaries,
irreversible actions, the human primary checkout, cross-session resources or hard quota stops are never
relaxed in a trial on real work; revisit them only from incident and audit evidence.

| Rule | Assumption it encodes | Origin | Revisit when | Trial |
| --- | --- | --- | --- | --- |
| Per-host heavy-process limit | Workers do not coordinate host load; concurrent heavy checks overload the host and cause false timeouts | Host-overload incident (kit tutorial 03, README) | Host hardware or measured peaks change | Yes, with host monitoring |
| Explicit `model` on every dispatch | Dispatch defaults let workers inherit the caller's tier, and callers rarely override them unprompted | Inherited-tier incidents (tutorial 03, model routing and quota incidents); enforced on Claude Code by the dispatch guard since 2026-11-22 | Codex and workflow-script dispatches gain the same enforcement, or the default changes | Yes |
| No `fork` dispatch | A fork runs on the caller's model with its full context, so it can neither pick a worker tier nor be an isolated reviewer | Dispatch guard rule `fork-dispatch`, introduced 2026-11-22 | The runtime lets a fork set its model and drop the caller's context | Yes |
| `opus because sub-planner` line and `opus-sub-planner-only` guard | Orchestrators read "important" as "hard" and raise implementer and reviewer tiers; an unset session model inherited Opus 27 times and spent the 5-hour quota in 30 minutes | Firmware dispatch review (tutorial 03, model routing); cloud-session quota incident | A model generation changes | Yes |
| Workers run only authorized checks | Unconstrained workers widen checks to full suites, installs and shared cleanup | Host-overload incident; verification lanes | Check scheduling becomes mechanical | Yes |
| No writes into the human primary checkout | Agents edit wherever a path resolves, including the human's working tree | Worktree lifecycle (tutorial 02); enforced by the primary-write guard | Never by trial | No |
| One worker layer by default, at most two; reviewers never delegate | Nested contexts lose guardrails they were never told | Spawned-window blindness (dispatch decision); the kit's worker and reviewer roles have no dispatch tool | A trial shows nested children keep their guardrails through role definitions | Yes |
| `ps` proof at finish | Workers leave background shells, loops and watchers running | Background-process accumulation (heavy processes); a required field of a module-owner handoff | The runtime reports and reaps child processes itself | Yes |
| Quota stops at 95% and 97% | Host guidance treats cost as unconstrained; orchestrators do not stop on their own | Quota incidents (tutorial 03, quota and cadence) | Billing or quota structure changes | No |
| Exactly one private structured final | Workers otherwise message shared UI or other tasks, and liveness signals get read as results | Codex dispatch behavior (dispatch decision); shape checked by the worker handoff validator | The runtime offers a single typed result channel | Yes |
| Liveness check before takeover | Silence or a `completed` flag is taken as proof of death | Cross-session takeover and orchestrator-exit incidents (tutorial 03) | Never by trial | No |
| Finish gated on the verification result | Orchestrators chain build and finish unconditionally | Hand-patching incident (tutorial 03, quota and ownership) | Never by trial | No |
| Announcement without a running child is a stall | Workers end a turn by announcing a next step they never start | Announcement-stall detection (tutorial 03, supervision heartbeat) | A model generation changes; compare detector hit rates | Yes |
| Health-check task before a broad wave | A flawed packet or prompt fails identically across a whole wave | Wave batching (tutorial 03, dispatch patterns) | Role definitions and packet validation run cleanly across several waves | Yes |
| Independent pre-review and verdict intake | Authors grade their own work generously; diffs crowd the orchestrator's context | Design rule, introduced 2026-11-22; no recorded incident yet | Measured acceptance quality and orchestrator context use | Yes, outside the risk classes |
| Threshold B dispatch-only mode | A long-running implementing orchestrator loses decomposition and acceptance quality as its context fills | Design rule; no recorded incident yet | A model generation changes; compare a trial with and without | Yes |
| Sub-planner sizing (3 to 6 owners each, at most 6 direct reports) | One planner's attention and context hold only a handful of concurrently active owners | Design rule in trial status, introduced 2026-11-22 | After the first sub-planner trial, then each model generation | Yes |

When adding a red line, add its row here in the same change. A rule nobody can state an assumption for is a
candidate for removal, not for another paragraph of emphasis.

## Revisiting a rule

1. Trigger: a new model generation becomes the default for the orchestrator or a worker tier, a rule's
   stated condition in "Revisit when" occurs, or audits show a rule repeatedly blocking work without
   preventing its failure.
2. Pick at most three trial-eligible rules per revisit. Run each as a bounded trial with a review point,
   using the trial and evidence rules in [capacity balance](capacity-balance.md): state the expected effect,
   the observation window and the failure signal that ends the trial early.
3. Relaxing a rule in a trial means the packet states the relaxation for that bounded scope. Do not delete
   or edit the rule before the evidence is in.
4. Record the evidence, then keep, narrow or remove the rule in one change that also updates this table and
   any tutorial text that cites it. A trial with no comparable baseline keeps the rule.

Model names live in one place, the tier map in [model selection](model-selection.md); other references name
tiers. A model generation change updates that map, then starts a revisit here.
