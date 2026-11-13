import assert from "node:assert/strict";
import test from "node:test";
import type { GoalProgressUpdateState } from "../../contracts/src/index.js";
import { GoalProgressUpdateCoordinator } from "../src/update-coordinator.js";

test("an unconfigured Kit release channel reports manual updates without network checks", async () => {
  let state: GoalProgressUpdateState | null = null;
  const store = {
    path: "/unused/update.json",
    async read() {
      return state;
    },
    async write(value: GoalProgressUpdateState) {
      state = value;
      return value;
    },
  };
  const coordinator = new GoalProgressUpdateCoordinator({ store, currentVersion: "0.4.4" });
  const initial = await coordinator.initialize();
  assert.equal(initial.lastErrorCode, "GOAL_PROGRESS_UPDATE_CHANNEL_UNCONFIGURED");
  assert.equal(await coordinator.beginAutomaticCheck(), null);
  const request = await coordinator.handleIntent({ type: "check" });
  const result = await request.afterResponse?.();
  assert.equal(result?.lastErrorCode, "GOAL_PROGRESS_UPDATE_CHANNEL_UNCONFIGURED");
});
