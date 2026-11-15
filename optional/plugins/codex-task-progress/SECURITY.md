# Security policy

## Supported versions

Security fixes target the latest source plugin on the default branch and the latest published
Release. Upgrade before reproducing an issue. Older releases may not receive backports.

## Reporting a vulnerability

Use the repository Security tab to report a vulnerability privately when private reporting is
available. Otherwise open an issue containing only a request for a private contact channel.
Do not include credentials, private conversations, or an exploit against another user in a public issue.
Include the affected version, operating system, impact, and minimal reproduction steps.

## Local runtime and data

Task Progress runs on the user's computer. Its Helper stores task progress, settings, and logs in
the plugin data directory. The native-only release uses Codex MCP Apps, an MCP stdio server and a
private local Unix socket to reach the Helper. It does not inspect or modify Codex's application
UI, files, or signatures. The native panel requires MCP Apps host support; visibility is not
guaranteed on unsupported hosts.

The source plugin requires Node.js 22.12+ and pnpm 11. First use downloads locked npm dependencies
and builds the runtime locally. Update checks contact GitHub. The plugin does not send checklist
contents to its maintainers or start a separate model request to calculate progress.

The source plugin's uninstall tool removes that plugin and its progress data. Preserve canonical
Kit task and Heartbeat records when removing the plugin. Version 0.6.0 detects legacy CDP/launcher
installation markers and stops before overwriting; use the old installed version's safe removal
procedure before upgrading. Codex manages its own permissions and authentication. The installer
does not grant protected-folder permissions or change MCP Apps feature settings.
