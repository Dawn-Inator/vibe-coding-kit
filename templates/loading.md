# Project instructions

Add project-specific operating rules here. Keep product policy, command names, identity, and release boundaries in this project-owned file; the shared kit supplies reusable tools and skill sources.

For browser-based work, prefer the agent's built-in or in-app browser to avoid disturbing the owner's browser windows. If it cannot meet the task's needs, prefer an isolated or headless browser. Use an external browser such as Chrome or Safari only when the user explicitly requests it or the task requires capabilities unavailable through those alternatives; respect any stricter project rules.

Use `node engineering/automation/vibe-coding/bootstrap.mjs skills check` to validate generated skill projections and `node engineering/automation/vibe-coding/bootstrap.mjs worktree status` to inspect managed worktrees.

For ordinary frontend additions or changes, load `frontend-layering-boundaries`; for backend additions or changes, load `backend-layering`. Each guides a reuse-first search and preserves the project's ownership and boundary rules.
