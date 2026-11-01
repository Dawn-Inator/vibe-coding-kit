---
name: migration-downpath
description: Use before adding or reviewing a database migration with schema, destructive, type-conversion, data-rewrite, backfill, or rename implications. Governs reversibility and recovery evidence.
---

# Migration Downpath

Before writing or reviewing a migration, use the project's current versioned migration and ledger authority. Classify each new migration as reversible, irreversible, or forward-only; require a real recovery path and evidence appropriate to destructive changes. Never edit a migration already merged into a base branch or executed or forge ledger evidence; use a forward fix. Reconcile all affected targets before any authorized write and use the project's managed deployment path.

Read [migration contract](references/migration-contract.md) for declaration, ledger, replay, immutable checksums, rehearsal and recovery details, and [online safety](references/online-safety.md) for stage-specific authorization. Project adapters supply actual paths, commands, approval and ledger semantics. Do not treat old examples or audits as current execution evidence.

New persistent stores require [data-architecture-card](../data-architecture-card/SKILL.md); service or ownership changes require [business-boundary-cards](../business-boundary-cards/SKILL.md). Follow the developer's instructions on tests.
