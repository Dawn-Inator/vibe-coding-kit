---
name: manage-knowledge-artifacts
description: Use whenever creating, modifying, splitting, merging, moving, or retiring project Skills, docs, AI history, .workspace / .todolist plans or reviews, loading rules, generated knowledge projections, runbooks, architecture or policy Markdown, handoffs, or machine-readable governance sources; also use before adding substantial Markdown when its durable location is unclear, when a developer explicitly rejects an AI suggestion, recommendation, or plan and the rejection needs recording so future AI stops re-asking (rejected suggestion, don't re-ask), or after editing a Skill / .vibe-coding/loading.md and needing to regenerate synced projections (skills:sync, sync skills after editing). Classify the artifact, find and update the existing authority, keep generated projections non-canonical, route tracked work through a managed worktree and local-only transient work to the primary .workspace (executing now) or .todolist (deferred backlog), and prevent Skill/Doc/History/memory duplication.
---

# Manage Knowledge Artifacts

This skill governs where new project knowledge goes: into a **Skill** (an executable how-to an AI agent
follows), a **Doc** (a canonical explanation of how/why something works, or a standing policy), **History**
(a record of what was done and decided, for future sessions to recall), **memory** (a narrow retrieval-keyed
correction for a recurring mistake shape), a **tutorial chapter** (a human-facing "why this rule exists"
narrative — a generalized, de-branded worked case study that accompanies a Skill or a starter-kit doc, for
a reader building understanding rather than an AI executing a task), or a **transient list**
(`.workspace`/`.todolist`, local work-in-progress that never becomes a durable source of truth on its own).

**Tutorial vs. memory — same trigger, different readers, not a duplicate source.** Both can originate from
the same incident, but they answer different questions for different audiences: memory answers "what
mistake shape has *this project's own* AI made before, and how do I recognize it fast enough to avoid
repeating it" — narrow, retrieval-keyed, tied to this project's own concrete history, and never written in
de-branded/generalized form. A tutorial chapter answers "why does this Skill's rule exist, in a form a human
(or an adopting project) can learn from" — a worked, generalized case study explaining the reasoning, with
project-specific names/paths/domains stripped out the same way the rest of a starter kit is de-branded.
Writing both from one real incident is not a duplicate source: one is this project's own narrow AI-facing
correction, the other is the methodology-level teaching material a Skill points to for its "why." If your
project doesn't ship its own tutorial (only consumes one, or has neither), skip that half and write memory
only.

**A Skill's body must never carry a concrete incident narrative — only the distilled rule plus a one-clause
pointer to where the incident actually lives.** "One overnight session absorbed 21 conflicts...", "one
project's incident: the orchestrating session exited mid-session...", or any other scene-setting sentence
inside a Skill's prose is a governance violation, not a stylistic choice — it belongs in the tutorial
chapter (or, for a project's own non-generalized history, memory) that the Skill should instead point to
with a single sentence ("See your project's tutorial for the incident that motivated this rule."). This
applies even when a Skill is actively being written or extended, not only during a later trim pass — the
default failure mode is a narrative creeping back in while porting or writing a new section, exactly because
writing the story down alongside the rule feels natural in the moment. Before finishing any Skill edit,
grep the touched sections for a first-person incident description (dates, specific counts, "a session
did X") and relocate anything you find, the same way an editing pass would relocate one found later — do
not treat this as optional cleanup deferred to a future trim. The only exception is a single-clause example
that names no session, date, or count, used purely to illustrate what a rule means (e.g. "a one-liner fix
is not exempt") — that is illustration, not narrative, and can stay.

This skill assumes your project keeps (or will create) one canonical governance document that owns the full
classification policy and the exact Artifact Decision Card fields — do not copy the policy itself into this
Skill file; point to your own doc instead (a reasonable name is `doc/knowledge-artifact-governance.md`, or
wherever your project keeps cross-cutting policy docs). If you have not written that doc yet, the card
below is a reasonable starting template — copy it into your own governance doc and adjust the fields as your
project's needs become clearer, then have this Skill point at it instead of inlining the template again here.

## Artifact Decision Card (starting template — move this into your own governance doc)

For every new substantial piece of knowledge, answer:

1. **What is it?** An executable procedure an AI should follow (→ Skill) · a canonical explanation of a
   system, or a standing policy/decision (→ Doc) · a record of what happened and why (→ History) · a narrow
   "don't repeat this mistake" correction tied to a retrieval cue, in this project's own concrete terms
   (→ memory) · a generalized, de-branded "why this rule exists" worked case study for a human reader or an
   adopting project (→ tutorial) · in-progress, local-only, not meant to outlive the current task
   (→ `.workspace`/`.todolist`).
   **"Decision" is not a type — route it by what it constrains.** A rule/design the system now follows
   (revisable in place) → Doc. An instruction about how the AI should work that no single must-read Doc
   can carry → memory (or co-locate it in the Doc that is always open at the point of error). A one-time
   options analysis plus the reason A was chosen over B (frozen once written) → History. A document that
   holds both splits: the outcome goes into the Doc it changed, the options and rationale stay in
   History, each pointing at the other without copying.
2. **Does an authority for this subject already exist?** Search existing Skills, Docs, History, loading
   projections, code/config/test, and the local primary `.workspace`/`.todolist` before writing anything new.
   Prefer modifying the existing authority over creating a near-duplicate.
3. **Operation**: create | modify | split | merge | move | retire.
4. **Where does the write land?** Per the routing rules below.
5. **What has to be regenerated or re-validated afterward?** Sync commands, index files, ownership checks.

When the answer is clear, proceed without asking for confirmation; stop only for a material authority
conflict, a destructive-retirement ambiguity, or a missing decision that changes intent.

**Where each kind lands (directory convention).** Doc → `doc/` (default; the doc-index script scans `doc/`
only, so a canonical Doc kept elsewhere never enters the index) · Skill → `.vibe-coding/skills/` · tutorial →
`.vibe-coding/tutorial/` · History → `.vibe-coding/history/` · session-level temporary material (handoff,
RESUME, in-flight registry, drafts) → `.workspace/` (untracked) · decided-but-unscheduled plans, proposals and
remaining-work lists → `.todolist/` (tracked). Temporary state never goes into `doc/`; promoting
`.workspace` → `.todolist` is a start/defer decision, and a handoff that another machine must pick up is
promoted into `.todolist/`. Temporary artifacts carry no tests, gates, CI or formatting checks; if it needs a
gate, it is a Doc. The full table lives in the starter kit's README, "知识产物落点".

## Workflow

1. Determine whether the request is discussion-only or authorizes writes. Discussion-only requests stop
   after a classification recommendation.
2. Search existing Skills, Docs, History, loading projections, code/config/test, and the local primary
   `.workspace` and `.todolist` for the same subject. Prefer modifying the existing authority over creating a
   near-duplicate.
3. Fill the Artifact Decision Card above (or your project's own copy of it) for every subject. When the
   answer is clear, proceed without asking for confirmation; stop only for a material authority conflict,
   destructive retirement ambiguity, or a missing user decision that changes intent.
4. Route the write exactly as the Card declares:
   - Use the managed tracked worktree for Skill, Doc, History, loading, code, config, and tests.
   - Resolve the primary worktree path via your worktree tool's status command (e.g. `pnpm worktree:status`)
     and write transient work only to your own session directory in that primary worktree —
     `.workspace/task/<yyyy-mm-dd>-<topic-slug>/` (executing now; drafts in its `drafts/`) — or to `.todolist/`
     (deferred); never stage `.workspace`, never modify another session's directory (record the author as
     `owner:` in its `session.md`). Route by whether the work
     runs THIS round, not by how finished it looks. Promoting `.todolist` → `.workspace` is a decision to
     start, so it needs its own Card (`operation: move`).
   - **The two are not equally private by default.** `.workspace` is pure in-flight execution scratch — keep
     it gitignored, local-only, never committed. `.todolist` is a *backlog* (decided but not yet started) —
     a project may deliberately choose to git-track it instead, precisely so it survives a `git clone`/pull
     for cross-machine or cross-session handoff (a design draft, a deferred proposal someone else should be
     able to see). That is a per-project call, not a default this kit makes for you — see your INSTALL step
     for `.gitignore` and record whichever way you decide as its own Card/decision so a later session doesn't
     silently "fix" it back the other way.
   - Treat `.workspace` and `.todolist` as transient input only. Before any tracked artifact depends on a
     decision from either, promote that decision into the canonical Doc/Skill and remove the reference.
   - Treat generated knowledge trees (derived, regenerable projections of canonical sources) as
     `NON-CANONICAL` supporting projections. Change the canonical Doc/Skill/History/code first, then
     regenerate; stop if the projection lacks source provenance, crosses its write/input allowlist,
     exposes secret/PII, or would become another active truth.
5. Apply whatever type-specific skill or convention your project has for the artifact type: a
   skill-authoring convention for Skill work, a history/decision-log convention for History, and this kit's
   worktree-guard commands (`pnpm worktree:begin` / `pnpm worktree:end`, see the worktree-guard tool this
   starter kit ships) for tracked implementation. Keep Doc as authority for a combined `skill+doc` case.
   For `memory`, follow your project's memory-authoring convention if you have one (this starter kit ships
   the sync commands `memory:index`/`check:memory` but not an authoring workflow — write your own, or skip
   memory entirely and fold corrections into the relevant Doc). Apply a co-location test before writing to
   memory: if exactly one Doc is necessarily already open when the mistake gets made, the correction belongs
   in that Doc's prose, not in memory. Run `pnpm memory:index` after writing to memory. The same co-location
   test governs rejected-suggestion records — see below.
6. Update required loading/index/ownership/generated projections once at the orchestrator boundary, run
   the Card's light validations, and review the real diff for duplicate current truth. Generation and
   promotion of any generated projection are local/manual only, reusing the existing knowledge-artifact
   validation channel. Do not add a generation workflow, schedule, or automatic PR behavior without a
   separate governance decision. Adding a new Doc means giving it whatever frontmatter your doc-index
   convention expects and running `pnpm docs:index` to regenerate your generated doc index — never
   hand-maintain a doc list inside a Skill or `.vibe-coding/loading.md`.
7. **After touching a Skill, `.vibe-coding/loading.md`, or a governance Doc, check whether your project's
   upstream starter-kit template and its tutorial need the same update.** If your project was bootstrapped
   from (or keeps syncing with) a separate template repository, a durable improvement made here — a new hard
   rule, a fixed gap in a skill's workflow, a corrected default — silently drifts from that template unless
   it's ported back in the same batch. Concretely: decide per changed file whether the change is
   project-specific fact (stays local only) or a generalizable rule/pattern (needs porting). For anything
   generalizable, port it into the template's mirror of that file **by paragraph, never by whole-file
   overwrite** (a whole-file sync from the template back into a live project has previously clobbered local
   improvements — the same risk applies in reverse), stripping any project-specific names/paths/domains and
   replacing concrete numbers with "example value, tune for your own host/quota" while keeping the
   requirement that a project pick *some* concrete number. Do the same check for the corresponding tutorial
   chapter if your project keeps one (teach the generalized lesson with the concrete numbers as a worked
   example, not as a literal requirement). If neither needs an update, say so explicitly in the delivery
   note along with why — "checked, no starter-kit/tutorial change needed because …" is a valid outcome, but
   skipping the check silently is not.

## Recording a rejected AI suggestion

When a developer explicitly rejects an AI question, suggestion, recommendation, or plan, the rejection
must be written into a Doc so future AI sessions stop re-asking it — this is itself a knowledge-artifact
write and goes through the same Card and authority-search steps above, not an ad hoc edit.

- **Where**: apply the co-location test from step 5 — find the one Doc an AI necessarily already has open
  before it would raise this suggestion again (for example, a rejected performance-tuning suggestion belongs
  in your architecture doc; a rejected security-hardening suggestion belongs in your security/secret-handling
  doc), and write there instead of in scattered History entries. A decision already codified as a hard rule
  in your top-level project-instructions file (e.g. `CLAUDE.md` / `.vibe-coding/loading.md`) stays there; do
  not duplicate it into a Doc. Only fall back to a memory mechanism when the re-ask entry point is genuinely
  scattered across multiple Docs or task types and the retrieval key is "the conclusion I'm about to reach"
  rather than the decision content itself — memory records the reasoning shape, not the decision.
- **What**: record three parts — the content that was rejected, the developer's reason (cost, priority,
  project stage, or an existing alternative), and a "don't re-ask" pointer telling future AI how to handle
  the same question next time.
- **Heading, not bold text**: use a `###`/`####` heading for the record (never only inline bold), because
  retrieval is a full-text search for heading lines such as
  `rg -n '^#{2,4}.*(Established decision|Rejected suggestion|Don.t re-ask)'` — an inline
  `- **Don't re-ask**: …` line will not match and is equivalent to never having written it down. Pick one
  consistent heading vocabulary for your project and use it every time so the grep pattern stays reliable.

## Skill source directory sync

`.vibe-coding/skills/<name>/` and `.vibe-coding/loading.md` are the only hand-edited sources for
project-level Skills and loading rules. Any generated projections your tools read from those sources
(for example a Codex/Cursor-style `AGENTS.md` reader directory, a Claude Code `.claude/skills/` directory,
a top-level `AGENTS.md`, or a top-level `CLAUDE.md`) are generated — never hand-edit them, even though they
may stay committed so a fresh `git clone` gives every AI tool working Skills immediately.

After adding or changing a Skill or `.vibe-coding/loading.md`, edit only `.vibe-coding/*` and then run:

```bash
pnpm skills:sync
pnpm check:skills
```

Wire up whatever your project's equivalent of a unified "did doc-class content change" entry point is (if
you build one) to run `check:skills` and `check:history` internally; don't hand-maintain two separate
invocations at every call site. Do not add substantial explanatory content directly into
`.vibe-coding/loading.md` or your top-level project-instructions file — route it through the Artifact
Decision Card to a Doc or a Skill instead, and keep `loading.md` limited to triggers, hard rules, and
pointers.

### Platform-specific content: `claude-only` / `agent-only` markers

When a Skill or `.vibe-coding/loading.md` bullet is phrased as an actionable instruction that only one
platform can actually execute (a tool call that only exists on one host, e.g. a Claude-Code-only scheduling
mechanism; or a transport that only exists on the other host, e.g. a Codex-only private agent-to-agent
handoff channel), wrap that block instead of leaving it in the shared text for a platform that structurally
cannot follow it:

```
<!-- BEGIN: claude-only -->
... content that only makes sense for Claude Code ...
<!-- END: claude-only -->

<!-- BEGIN: agent-only -->
... content that only makes sense for Codex/Cursor (the ".agents" output) ...
<!-- END: agent-only -->
```

Delimiters must stand alone on their own line. The sync script (`engineering/automation/agent-skills/sync-skills.mjs` in
this starter kit) keeps the matching block for each generated target — unwrapped, delimiters removed,
content kept — and drops the opposite block entirely (delimiters and content both removed); content outside
any marker passes through untouched. This applies **only** to the sources that sync step actually
processes — `.vibe-coding/skills/*/SKILL.md` and `.vibe-coding/loading.md` — **not** to `doc/*.md`. A Doc a
Skill links out to is never run through this transform and is read in full by whichever platform opens it;
keep Doc prose platform-neutral (describe both branches narratively) rather than assuming marker wrapping
will hide part of it — it won't. If a Doc genuinely needs hard separation, that requires physically
splitting the Doc (a separate governance decision), not adding markers here.

Before writing a Skill/loading bullet that says "do X" where X is a tool or transport unique to one
platform, check whether this marker mechanism applies before assuming the sole option is to write one
shared sentence describing both platforms' behavior side by side. Once your project has a couple of these
blocks in place, point future edits at your own worked examples instead of re-deriving the pattern each time.

Do not turn this Skill into a second lifecycle or a copy of the governance Doc. The stopping rules,
classification details, migration rules, examples, and validation matrix belong in the linked Doc, not
copied here.

## Architectural changes must update the loading.md red-line row in the same batch

Any architectural change to your build/CI/CD configuration — retiring a workflow, changing its trigger,
changing a cost model, changing a gate entry point — must update the corresponding red-line row in
`.vibe-coding/loading.md` in the same batch, or the change is incomplete. If your project has previously
shipped an architectural change without updating that row, that is exactly the failure mode this rule exists
to prevent: the change looked complete in the diff but left a stale, actively-misleading instruction in the
file every AI session reads first. Record the full rule, rationale, and any concrete counter-example your
project accumulates in your own knowledge-artifact governance Doc; this Skill does not copy that text.
