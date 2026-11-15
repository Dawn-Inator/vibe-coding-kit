# Support

## Platform

| Surface | Current value |
|---|---|
| Task Progress release | 0.6.0 |
| Interface | Native Codex MCP App |
| Operating system | macOS |
| Architecture | Apple Silicon arm64 |
| Host requirement | Codex Desktop with MCP Apps support |
| Helper runtime | Node SEA v24.19.0 |
| Task and Heartbeat formats | Canonical Kit formats |
| Goal compatibility | Existing Codex model APIs and original v1/v2 data |

The native panel requires the host's optional `enable_mcp_apps` feature. Host support and actual UI visibility are separate checks; unsupported hosts may not display the panel.

## Installation results

Kit installs or reuses the native plugin and Helper. Existing installations are not silently upgraded. Version 0.6.0 stops when it detects legacy CDP/launcher markers; remove those with the old installed version's safe removal procedure before upgrading. The retired CDP panel and custom Dock launcher are not supported or rebuilt.

Helper health checks and plugin registration do not prove that the Codex host rendered the panel. Validate actual visibility and data in an ordinary chat on a supported host. Reopen or create a chat if the host has not loaded a changed plugin catalog.

For current setup steps and evidence boundaries, see [installation](../INSTALL-FOR-AI.md) and [validation](VALIDATION.md). Historical release records are retained in the [changelog](../CHANGELOG.md).
