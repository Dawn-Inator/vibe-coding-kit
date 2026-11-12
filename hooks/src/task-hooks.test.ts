import assert from "node:assert/strict";
import test from "node:test";
import { resolveTrustedToolAuthorization } from "../../packages/mcp/src/runtime-identity.js";
import {
  GOAL_PROGRESS_TOOL_MATCHER,
  handleHookInput,
  TASK_PROGRESS_SESSION_CONTEXT,
} from "./index.js";

test("ordinary SessionStart routes through shared guidance and honors read-only source tasks", async () => {
  const output = await handleHookInput(
    {
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: "chat-1",
      cwd: "/project",
      model: "test",
    },
    { resumeSession: async () => ({ status: "inactive" }) },
  );
  assert.equal(output?.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(
    output && "additionalContext" in output.hookSpecificOutput
      ? output.hookSpecificOutput.additionalContext
      : "",
    TASK_PROGRESS_SESSION_CONTEXT,
  );
  assert.match(
    TASK_PROGRESS_SESSION_CONTEXT,
    /\$codex-task-progress:task-progress Skill and bundled Kit guidance/,
  );
  assert.match(TASK_PROGRESS_SESSION_CONTEXT, /task_progress_get first/);
  assert.match(TASK_PROGRESS_SESSION_CONTEXT, /taskSource/);
  assert.match(TASK_PROGRESS_SESSION_CONTEXT, /pending-selection/);
  assert.doesNotMatch(TASK_PROGRESS_SESSION_CONTEXT, /A 100% checklist|verified evidence/);
  assert.ok(TASK_PROGRESS_SESSION_CONTEXT.length <= 512);
});

test("only the supported task and Goal MCP tools receive identity proofs", () => {
  for (const name of [
    "task_progress_get",
    "task_progress_initialize",
    "task_progress_update",
    "task_progress_rescope",
    "task_progress_history",
    "task_progress_bind_heartbeat",
    "mcp__codex_task_progress__task_progress_update",
    "goal_progress_update",
  ]) {
    assert.equal(GOAL_PROGRESS_TOOL_MATCHER.test(name), true, name);
  }
  for (const name of [
    "exec_command",
    "task_progress_delete",
    "task_progress_update_suffix",
    "pretendtask_progress_update",
  ]) {
    assert.equal(GOAL_PROGRESS_TOOL_MATCHER.test(name), false, name);
  }
});

test("task identity comes from trusted matching Codex metadata, never business input", () => {
  const result = resolveTrustedToolAuthorization(
    "task_progress_get",
    {},
    {
      _meta: {
        threadId: "chat-1",
        callId: "call-1",
        "x-codex-turn-metadata": {
          session_id: "chat-1",
          thread_id: "chat-1",
          turn_id: "turn-1",
          model: "test",
          thread_source: "user",
          cwd: "/project",
        },
      },
    },
    { recordDiagnostic: () => undefined },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.sessionId, "chat-1");
    assert.equal(result.auth.kind, "codex-request");
  }
  const rejected = resolveTrustedToolAuthorization(
    "task_progress_get",
    {},
    {
      _meta: {
        threadId: "another-chat",
        callId: "call-1",
        "x-codex-turn-metadata": {
          session_id: "chat-1",
          thread_id: "chat-1",
          turn_id: "turn-1",
          model: "test",
          thread_source: "user",
        },
      },
    },
    { recordDiagnostic: () => undefined },
  );
  assert.equal(rejected.ok, false);
});
