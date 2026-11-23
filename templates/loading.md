# Project instructions

Add project-specific operating rules here. Keep product policy, command names, identity, and release boundaries in this project-owned file; the shared kit supplies reusable tools and skill sources.

For every commit, including AI-assisted work, use the current human developer's name and email for both Git Author and Committer. Verify the effective identity before committing: use the developer's established Git identity, and ask if it is missing or ambiguous. Never substitute Claude, Codex, another AI/tool or bot identity, invent an identity, or default all contributors to the repository owner's identity. Do not add AI `Co-authored-by` trailers or AI signature footers; human co-author trailers must reflect actual contributors. Keep identity overrides repository-local or command-scoped. Do not rewrite existing commit history unless explicitly requested.

For browser-based work, prefer the agent's built-in or in-app browser to avoid disturbing the owner's browser windows. If it cannot meet the task's needs, prefer an isolated or headless browser. Use an external browser such as Chrome or Safari only when the user explicitly requests it or the task requires capabilities unavailable through those alternatives; respect any stricter project rules.

Exception: if the built-in browser lacks the login session needed for the task, check the owner's real Chrome for an existing session and use it when needed. Minimize disruption to the owner's windows and interact only as needed for the authorized task.

Use `node engineering/automation/vibe-coding/bootstrap.mjs skills check` to validate generated skill projections and `node engineering/automation/vibe-coding/bootstrap.mjs worktree status` to inspect managed worktrees.

For ordinary frontend additions or changes, load `frontend-layering-boundaries`; for backend additions or changes, load `backend-layering`. Each guides a reuse-first search and preserves the project's ownership and boundary rules.
