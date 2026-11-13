import { GOAL_PROGRESS_ACTIVE_ELEMENT_NAME } from "../../renderer/src/index.js";
import { installGoalProgressPageHost } from "./page-host.js";
import { installTaskProgressPageHost } from "./task-page-host.js";

if (typeof window !== "undefined") {
  installTaskProgressPageHost(window);
  installGoalProgressPageHost(window, {
    elementName: GOAL_PROGRESS_ACTIVE_ELEMENT_NAME,
  });
}
