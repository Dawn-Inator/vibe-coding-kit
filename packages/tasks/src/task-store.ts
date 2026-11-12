import { createTaskProgressSchemas } from "vibe-coding-kit/src/tasks/task-contract.mjs";
import {
  TaskStore as KitTaskStore,
  TaskStoreError,
} from "vibe-coding-kit/src/tasks/task-store.mjs";
import { z } from "zod";

const schemas = createTaskProgressSchemas(z);

/** Plugin adapter: persistence format, replay, idempotency and revisions live in the Kit. */
export class TaskStore extends KitTaskStore {
  constructor(root: string) {
    super(root, { schemas });
  }
}

export { TaskStoreError };
