# Architecture

Task Progress presents canonical Kit task progress and project Heartbeat records inside Codex Desktop's MCP Apps surface. The 0.6.0 product interface is native-only. Its former CDP renderer and custom Dock launcher are retired. The model remains responsible for interpreting goals and maintaining task scope; the plugin validates permitted mutations, delegates canonical persistence to Kit, and renders read-only data in the App.

## Request and data flow

```text
Codex MCP Apps resource
  → plugin MCP stdio server
  → local Helper over private IPC
  → canonical Kit task / History / Heartbeat APIs
  → bounded native App view
```

Kit's existing launchd service supervises the Helper. The native App requests data for the active trusted thread. The Helper resolves that identity and asks Kit for canonical records; writes continue to require the full Hook and turn proof. The panel itself does not write task or Heartbeat files.

## Responsibilities

| Component | Responsibility |
|---|---|
| Native MCP App | Presents task progress, History and read-only project Heartbeat data |
| MCP stdio server | Exposes the plugin's typed request surface and forwards authorized calls |
| Helper | Resolves trusted host/thread identity, enforces authority and brokers Kit APIs |
| Kit APIs | Own canonical task, history and Heartbeat data formats and persistence |
| Native Goal adapter | Retains compatibility with Codex native Goal model APIs and original v1/v2 records |

The native panel is a read-only view of task records. It does not create a Codex Goal and does not supply custom Goal UI. Project Heartbeat display is observational and cannot replace a chat's task authority unless Kit's existing source-association rules establish that relationship.

## History projection

The History UI displays a compact projection bounded to 512 KiB of source input and 512 Unicode characters per summary. Each summary retains the full canonical Markdown path for provenance. Truncation applies only to presentation: it does not rewrite, truncate, or replace Kit's source records.

## Compatibility

Task, History, Heartbeat and Goal model APIs/data formats remain compatible. The component release version is `0.6.0`. Existing installations that contain retired launcher/CDP markers must be handled by their old installer before upgrade; 0.6.0 detects those markers and stops rather than overwriting them. No retired launcher build or recovery workflow is part of the supported product.
