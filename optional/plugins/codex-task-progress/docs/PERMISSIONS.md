# Task Progress permissions

The native-only plugin uses Codex MCP Apps, an MCP stdio server, a private local IPC socket, the launchd-supervised Helper, and Codex's trusted host/thread metadata. It does not inspect or modify Codex's application UI, create a custom launcher, or change Codex feature settings.

The native panel requires host support for MCP Apps and the optional `enable_mcp_apps` feature. Inspect it with `codex features list`; the user controls that host setting. If selected, enable it with `codex features enable enable_mcp_apps`. Installation does not enable the feature; it returns `NATIVE_MCP_SETUP_REQUIRED` if support is unavailable or the feature is disabled. UI visibility remains unverified until observed in a supported host.

## Local data

Release files, Helper runtime, logs, install manifest, preferences and signing configuration live under `~/Library/Application Support/CodexTaskProgress`. Versioned release assets are kept under `install/releases/<version>/`; the active Helper is installed as a verified real executable at `install/bin/goal-progress`. The Helper and launchd identity remain `com.codextaskprogress.helper`. The listener identity remains `com.codextaskprogress.listener`.

Canonical ordinary task history is stored in the trusted chat working directory under `.workspace/codex-task-progress/tasks/v3/<thread-sha256>/taskhistory.md`; `heartbeat.md` is a readable projection, not the event authority. Rebuildable cache data is separate. Project Heartbeat ledgers are read through Kit's canonical inspection API and are not modified by display or observation. Native Goal data remains separate in its original Codex-owned formats. No personal task or project ledger data belongs in Git.

## Signing and macOS privacy

Signing uses the existing fixed identity and explicit local consent when a new choice is required. A stored signing choice is private configuration; it is not permission to create certificates, export keys, grant macOS privacy access or approve TCC prompts. An Apple Development signature is not Developer ID or notarization. Ad-hoc signing may result in another macOS protected-folder prompt.

macOS prompts for protected folders must be approved by the user in the system UI. The installer does not self-authorize or automate permission grants. Do not edit or reset the TCC database, and do not default to Full Disk Access. A path change or executable update may require renewed approval; existing grants are not copied or promised to persist.

## Upgrading legacy installations

Version 0.6.0 retires the CDP panel and managed Dock launcher. Its installer detects legacy installation markers and stops before replacing files. Use the old installed version's safe removal procedure, preserving task/history data as needed, then install from the trusted Kit checkout. Do not overwrite legacy files or attempt to build the retired launcher. Upstream Git history, license and attribution are retained in this derivative.

See [installation](../INSTALL-FOR-AI.md) and [architecture](ARCHITECTURE.md) for the supported flow.
