---
name: manage-knowledge-artifacts
description: Use when creating, modifying, moving, splitting, merging, or retiring Skills, docs, history, memory, tutorials, loading instructions, runbooks, architecture or policy docs, plans, reviews, knowledge projections, or governance sources. Route knowledge to its current authority, preserve links, and prevent duplicated or historical rules from entering the execution path.
---

# Manage Knowledge Artifacts

Use the project's canonical knowledge-governance document if it has one. This skill routes and verifies
changes; it does not create a second policy authority. Keep the entry concise and load
[authoring details](references/authoring-details.md) only for a question not answered here or by the
project's authority. Respect explicit developer instructions, including a request not to run tests.

## Route by purpose

- **Skill**: trigger, current actions, stops and verification; keep incident narratives out.
- **Doc**: current behavior, architecture, standing decisions and concise reasons needed to apply them.
- **History**: detailed incidents, past options, superseded designs and evidence. Mark it historical and
  point to the current authority. Read only matching entries when tracing context.
- **Memory**: retrieval cue, corrective guidance and current authority for recurring errors; not an
  incident archive. Put the correction in its necessarily-open Doc instead when there is one.
- **Tutorial**: generalized cases for readers and adopting projects, not a routine execution prerequisite.
- **Temporary work**: session work in `.workspace/`, deferred proposals in the project's chosen backlog;
  neither is canonical. Code/config/tests own machine-verifiable facts.

A decision's current result belongs in the affected current authority; its historical analysis belongs
in History. Existing historical business data and the rules that handle it are current behavior, not
an incident narrative. Link background for optional tracing and avoid duplicate current truth.

## Workflow

1. Discussion-only requests do not authorize writes. Search relevant existing authorities and consumers;
   for a bounded edit use the appropriate sections rather than loading the entire knowledge tree.
2. Identify purpose, authority, write location, affected references and necessary regeneration. For a
   new, moved or disputed artifact, use the project's decision card if one exists. Proceed autonomously
   when intent and authority are clear; stop for material conflicts, destructive ambiguity or missing intent.
3. Use the project's managed worktree for tracked changes. Preserve project-specific adapter, policy and
   authorizations; make public Skill improvements in the public source, not a consumer's pinned copy.
4. Update the current authority first, move detailed historical narrative to History and generalized
   teaching material to tutorial. Preserve old links or update consumers and indexes; do not require an
   unrelated routine workflow to read historical context. Treat generated projections as non-canonical.
5. A rejected suggestion belongs in the Doc necessarily read at the point of recurrence, with the rejected
   proposal, reason and future handling; only use indexed memory when no such single Doc exists. Do not
   duplicate a current decision already enforced by an instruction file.
6. Regenerate required Skill and knowledge indexes at the change boundary, review the actual diff and
   links, and run validation selected by project policy and the developer's current instruction. Check
   whether the same general rule or teaching case needs updating in the public kit and tutorial.

Keep shared rules in the kit; use `extend` for additive project rules. `replace` requires an explicit
reason and review against the public contract; do not silently weaken its invariants. A project's stronger
or more specific rule belongs in its extension or canonical Doc. Instructions unique to one agent
platform use the platform markers provided by the sync mechanism, not platform-specific commands in a
shared Doc. Changes to gate/deployment authority must update the relevant always-loaded project policy.
