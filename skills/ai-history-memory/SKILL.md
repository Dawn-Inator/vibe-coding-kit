---
name: ai-history-memory
description: Use when AI agents working on this project need cross-session history, prior decisions, implementation context, handoff notes, repeated bugfix context, escape-analysis or missing-regression-coverage context, or when completing work that should be recorded under .vibe-coding/history for future sessions (by any AI tool or human).
---

# AI History Memory

Use `.vibe-coding/history/` as the shared, repo-local memory for durable AI decisions and handoffs. Treat history as context, not current truth: verify drift-prone facts against live code, docs, infra, or commands before relying on them.

If your project has a canonical doc describing this memory policy in more detail (for example under `doc/`), read it before changing the policy itself, the history-check tooling, or the boundary between comments, canonical docs, and history entries. If you have not written such a doc yet, this file is the whole policy.

## Read History

Read history before acting when any of these apply:

- The user asks about previous work, prior decisions, "what did we decide last time", "why is it built this way", or other cross-session context.
- The task resumes, audits, or rewrites a prior architecture, deployment, gate, secret-handling, migration, release, or agent-orchestration decision, or depends on one.
- Multiple agents are working in parallel and a prior handoff could affect ownership or file boundaries.
- You are about to change a policy-like file such as this project's agent-instructions file (e.g. `AGENTS.md` / `CLAUDE.md`), `.vibe-coding/loading.md`, `.vibe-coding/skills/**`, `doc/**`, CI/gate scripts, or deployment/runtime configuration.
- A bug is reported as recurring, already fixed before, platform-specific, third-party/provider-related, or connected to escape analysis, a regression-coverage gap, or missing automated coverage.

Start with `.vibe-coding/history/README.md`, the current month's index if present, then only the entries whose title, category, scope, or related files match the task. Use a text/code search tool (e.g. `rg` or `grep`) to find matching entries rather than reading every file; do not load the entire history tree by default.

## Write History

Add or update a history entry after work that future sessions need to remember:

- A long-lived architecture, workflow, gate, deployment, environment, migration, release, secret-governance, or agent-process decision changed.
- A non-obvious tradeoff, rollback reason, incident finding, or cross-agent coordination rule would prevent future rework.
- The final state differs from a plan, a previous entry, or a common assumption.
- A non-obvious repeated, platform-specific, or third-party/provider bugfix landed and future agents need the root cause, the original automated-coverage gap or escape reason, the regression spec or governance path, and a pointer to the related doc or commit.

Do not write history for ordinary obvious bugfixes, routine copy changes, local-only scratch work, generated noise, or facts already captured better in a canonical `doc/` page. If canonical docs changed, history should summarize *why* and point to those files instead of duplicating them. For bugfix entries, keep the note concise: root cause, escape reason, regression spec/governance path, and related docs/commit are enough.

## Entry Contract

Create entries under `.vibe-coding/history/YYYY-MM/DD-slug.md`. Every entry must have YAML frontmatter with exactly these required fields:

```yaml
---
title: "Short human title"
date: "YYYY-MM-DD"
author: "agent-name | human-name"
purpose: "Why this entry exists"
category: "architecture | workflow | release | operations | security | data | ui | ai-collaboration | other"
scope:
  - "repo/path/or/domain"
status: "active | superseded | archived"
related_files:
  - "repo/path"
redaction: "none | redacted | safe-placeholders"
---
```

Use these body sections, in this order:

```markdown
## Summary

## Changed

## Verification

## Follow-up
```

Keep entries concise. Prefer repo paths, commit SHAs, command names, and evidence pointers over narrative.

## Redaction

Never write plaintext secrets, tokens, cookies, passwords, private keys, full connection strings, personal access tokens, or raw customer PII. Report secret values only as `<set>`, `<empty>`, or `<redacted>`. It is fine to name an env var or vault key in prose, but do not write secret-like assignments with real values. If an entry discusses a compromised value or credential placement, set `redaction: "redacted"` and describe only the safe handling path.

## Indexes

Monthly `index.md` files are navigational aids and may be regenerated. Keep manual index edits minimal: title, date, category, status, and links are enough. Treat `README.md` and `**/index.md` as non-entry files.

If your project uses the kit's history-index module, keep the index in sync with:

```bash
node .vibe-coding/kit/src/knowledge/history/history-index.mjs sync   # regenerate navigation indexes
node .vibe-coding/kit/src/knowledge/history/history-index.mjs check  # verify the indexes
```

`init` does not add package-script aliases for history indexing; projects may add their own wrappers.

As the project progresses, `.vibe-coding/history/` will accumulate entries across many months — keep using the monthly folder structure (`YYYY-MM/DD-slug.md`) rather than one flat directory, so search and indexing stay fast as it grows.
