---
name: app-store-compliance
description: Audit an iOS or Android app for App Store or Google Play submission readiness, or investigate a store rejection and prepare an evidence-based fix plan.
---

# App Store compliance review

Review the requested app, release, or rejection against the applicable store policies. This is a Kit-authored workflow; the optional upstream playbook and scanners are external references, not bundled dependencies. Enabling this skill installs guidance only.

## Establish the review target

Find the app root, platform, framework, release configuration, intended storefronts, and submission stage from the project. For a rejection, read the exact reviewer message and identify the affected build and policy before proposing changes. Ask only for missing context that affects the decision; continue independent source review while waiting.

Use the requested scope. A compliance audit starts read-only. Existing authorization for fixes still applies; an audit alone does not authorize account changes, policy declarations, uploads, appeals, or a release gate. Follow the project's test policy and release workflow.

## Check evidence against current policy

Read [the evidence guide](references/audit-evidence.md) for the applicable review areas and official sources. Open the current official policy before asserting a requirement, deadline, regional exception, or store-specific violation. Record the URL, access date, and relevant section. If a source is unavailable, identify the resulting uncertainty.

Inspect the shipping implementation and release configuration, dependency inventory, store metadata, and available runtime evidence. Follow the actual data and payment flows; a dependency name or source keyword alone does not establish behavior. Distinguish:

- **Confirmed issue:** observed behavior or configuration conflicts with an applicable, verified policy.
- **Needs verification:** a scanner clue, missing runtime proof, or unavailable console declaration.
- **Not applicable:** the policy's platform, feature, account, or regional conditions do not apply, with the reason recorded.

Read only the relevant review areas. Prioritize access for reviewers, privacy declarations, permissions, deletion, purchases, and listing accuracy when they apply. Treat third-party checklists as leads and verify their interpretation against official text.

## Optional upstream tooling

For the external playbook's fixed reference version, licensing boundary, resource map, and manual scanner commands, read [upstream tooling](references/upstream.md). Use the evidence workflow without that checkout when it is absent. Do not install upstream hooks or clone the repository merely to enable or invoke this skill.

If using an existing, authorized upstream checkout, inspect its revision and scanner behavior first. Preserve raw output, exit status, coverage, and command details. Recheck findings against the app and current official policy. A clean scanner result only describes its implemented checks; incomplete coverage remains visible.

## Deliver the review

For each finding, give severity, evidence status, affected platform/build/region, file and line or console field, applicable official policy, practical impact, and a concrete fix or verification step. Redact credentials and personal data. For a rejection, connect each proposed fix or reply to the actual reviewer concern; do not change unrelated features or make unsupported claims about reviewer intent.

Conclude with one of: **confirmed blockers**, **verification incomplete**, or **no confirmed blockers in the reviewed scope**. State what was inspected and what remains unknown, including console-only checks and device behavior. Do not equate this conclusion with guaranteed approval or automatic permission to submit. If fixes were authorized, report implemented changes separately from checks actually performed.
