# Task Progress development

Preserve upstream MIT attribution and Git history. Task stores and private heartbeat records are runtime data, never repository content.

Run `corepack pnpm verify:public`, `corepack pnpm test`, and `corepack pnpm test:ui` for changes to the task flow. Keep Helper as the sole durable task writer. Preserve verified thread binding on native MCP and native Goal model paths. Delegate canonical task, History and Heartbeat storage/authority to Kit; do not rewrite source records to fit a UI summary. Any storage migration must use Kit's migration contract and preserve revisions, source associations, history and original records.

For installation follow INSTALL-FOR-AI.md. This is a native-only plugin: do not restore CDP, debug-port, custom Dock launcher, or app-restart behavior. The installer does not enable Codex's `enable_mcp_apps` host feature; if it returns `NATIVE_MCP_SETUP_REQUIRED`, report that code and direct the user to the explicit feature step in the installation guide. No Hook or source bootstrap may silently restart Codex. Report CLI diagnostics separately from actual native panel visibility and ordinary-chat data verification.
