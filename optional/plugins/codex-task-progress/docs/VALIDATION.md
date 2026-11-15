# Validation status

## Current native release

Version 0.5.18's native MCP App was observed working in the supported Codex Desktop host. The native path reads the same Kit task, History and Heartbeat records through the Helper. This is actual host/UI evidence for 0.5.18; plugin registration or a build alone is not equivalent evidence.

Version 0.6.0 retires the CDP panel and custom Dock launcher and adds the native-only upgrade guard and bounded History summary projection. These 0.6.0 changes have not been validated by this document. Record selected automated checks, Helper health, installation outcome, and actual native UI/data visibility separately after validation. Do not carry forward 0.5.18 evidence as proof of 0.6.0 behavior.

## Native host acceptance

For a supported Codex Desktop host with MCP Apps enabled, verify in an ordinary chat that:

- The native panel is visible and bound to the current trusted user thread.
- Task status, evidence and progress match canonical Kit records.
- History displays bounded summaries and full Markdown paths, while the source record remains unchanged.
- Project Heartbeat is read-only and does not replace unrelated task authority.
- Pagination, panel switching, keyboard focus, Escape, themes, narrow/short windows and reduced motion behave as expected.
- The new Helper is healthy and the host loads the current plugin catalog.

Hosts without MCP Apps support may not display the panel; no UI guarantee is made for them. Changing the host feature setting may require reopening or creating a chat.

## Installer and compatibility acceptance

Version 0.6.0 should be checked on both clean and legacy-marked fixtures. A clean install must use the native plugin + Helper path without a Dock prompt. A legacy marker must stop installation before any overwrite and provide safe upgrade guidance. Existing task, History, Heartbeat and native Goal data must remain readable. Verify exact source bytes are unchanged when only bounded History summaries are rendered. Confirm any preexisting installation's old-version removal is completed before applying the new installer.

Separate automated test, build, Helper `doctor`/`verify`, plugin registration, and actual host UI evidence in reports. A successful test run or command exit is not evidence that a host rendered the panel.
