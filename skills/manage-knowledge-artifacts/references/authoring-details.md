# Knowledge artifact authoring details

Use this reference for routing edge cases, agent-platform projections, or updating a shared kit. The
project's canonical governance Doc remains authoritative for project paths, validation and policy.

## Decisions and rejection records

Record an active rule or design in the current Doc and the one-time options analysis in History. When a
developer explicitly rejects a recommendation, write its content, reason and future handling in the one
Doc necessarily read before that recommendation would recur. If no such Doc exists, use an indexed memory
correction. Give the record a searchable heading following the project's heading convention; do not create
a second record for a decision already enforced by an always-loaded project instruction.

## Project and shared sources

Use a managed worktree for tracked source changes when the project enables that workflow. Check whether
changes generalize to the kit and, separately, whether they deserve a tutorial. Do not copy a whole project
Skill into the kit: retain general rules in the public source and project facts in the extension. Generated
`.agents/skills`, `.claude/skills`, root agent instructions and knowledge indexes are projections; edit
source and regenerate using the project adapter. A project's configuration determines what is tracked.

## Platform-specific instructions

Use separate-line `<!-- BEGIN: claude-only -->` / `<!-- END: claude-only -->` or
`<!-- BEGIN: agent-only -->` / `<!-- END: agent-only -->` blocks only in sources processed by the project
sync. Shared Docs are not automatically filtered; write them platform-neutrally or split their content.
Do not invent a tool call for a platform that lacks it.

## Recordkeeping and verification

For each substantial change identify its authority, operation, write location and affected consumers.
For moving or retiring material, preserve links and labels and ensure historic text cannot be mistaken
for current policy. Regenerate indexes and projections once at the integration boundary. Select checks
according to project policy and the developer's request; never imply a test was run when it was not.
