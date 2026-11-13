import assert from "node:assert/strict";
import test from "node:test";
import { projectTaskExecution } from "../src/task-execution.js";

const observedAt = new Date("2026-11-11T18:00:00.000Z");

test("runtime activity is independent of checklist percentages or completion claims", () => {
  assert.deepEqual(
    projectTaskExecution(
      { type: "active", activeFlags: [], percent: 100, phase: "completed" },
      observedAt,
    ),
    {
      state: "working",
      activeFlags: [],
      observedAt: observedAt.toISOString(),
      source: "codex-app-server",
    },
  );
  assert.equal(projectTaskExecution({ type: "idle", percent: 0 }, observedAt).state, "idle");
});

test("known active waiting flags are bounded, deduplicated and explicitly waiting", () => {
  for (const flag of ["waitingOnApproval", "waitingOnUserInput"]) {
    assert.deepEqual(
      projectTaskExecution({ type: "active", activeFlags: [flag, flag] }, observedAt),
      {
        state: "waiting",
        activeFlags: [flag],
        observedAt: observedAt.toISOString(),
        source: "codex-app-server",
      },
    );
  }
  assert.deepEqual(
    projectTaskExecution(
      { type: "active", activeFlags: ["waitingOnUserInput", "waitingOnApproval"] },
      observedAt,
    ).activeFlags,
    ["waitingOnApproval", "waitingOnUserInput"],
  );
});

test("unavailable, malformed, future and contradictory runtime statuses remain unknown", () => {
  for (const status of [
    null,
    undefined,
    "idle",
    [],
    {},
    { type: "notLoaded" },
    { type: "systemError" },
    { type: "completed" },
    { type: "active" },
    { type: "active", activeFlags: null },
    { type: "active", activeFlags: "waitingOnApproval" },
    { type: "active", activeFlags: ["futureUnknownFlag"] },
    { type: "active", activeFlags: ["waitingOnApproval", 1] },
    { type: "active", activeFlags: Array(17).fill("waitingOnApproval") },
    { type: "idle", activeFlags: ["waitingOnApproval"] },
    { type: "idle", activeFlags: null },
  ]) {
    const result = projectTaskExecution(status, observedAt);
    assert.equal(result.state, "unknown", JSON.stringify(status));
    assert.equal(result.activeFlags, undefined);
  }
  assert.equal(projectTaskExecution({ type: "idle", activeFlags: [] }, observedAt).state, "idle");
});

test("observation time comes from the trusted read, never a future timestamp in status", () => {
  const result = projectTaskExecution(
    { type: "active", activeFlags: [], observedAt: "2999-01-01T00:00:00Z" },
    observedAt,
  );
  assert.equal(result.observedAt, observedAt.toISOString());
  assert.throws(() => projectTaskExecution({ type: "idle" }, new Date("invalid")), RangeError);
});
