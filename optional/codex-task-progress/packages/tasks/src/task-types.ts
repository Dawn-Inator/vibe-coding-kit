import type {
  TaskEvent,
  TaskEvidence,
  TaskHistoryPage,
  TaskInitializeInput,
  TaskItem,
  TaskMutationResult,
  TaskObjective,
  TaskProgress,
  TaskRescopeInput,
  TaskState,
  TaskStatus,
  TaskUpdateInput,
} from "vibe-coding-kit/src/tasks/task-contract.mjs";
import {
  calculateTaskProgress,
  createTaskProgressSchemas,
} from "vibe-coding-kit/src/tasks/task-contract.mjs";
import { z } from "zod";

/** The Kit owns task validation and progress semantics; this module adapts its injected-Zod factory. */
const kitSchemas = createTaskProgressSchemas(z);

// The Kit injects Zod so consumers share its validation rules and transport-visible object shapes.
export const TaskStatusSchema = kitSchemas.TaskStatusSchema;
export const TaskEvidenceSchema = kitSchemas.TaskEvidenceSchema;
export const TaskItemSchema = kitSchemas.TaskItemSchema;
export const TaskObjectiveSchema = kitSchemas.TaskObjectiveSchema;
export const TaskObjectivesSchema = kitSchemas.TaskObjectivesSchema;
export const TaskInitializeInputSchema = kitSchemas.TaskInitializeInputSchema;
export const TaskUpdateInputSchema = kitSchemas.TaskUpdateInputSchema;
export const TaskRescopeInputSchema = kitSchemas.TaskRescopeInputSchema;
export const TaskProgressSchema = kitSchemas.TaskProgressSchema;
export const TaskStateSchema = kitSchemas.TaskStateSchema;
export const TaskEventSchema = kitSchemas.TaskEventSchema;
export type {
  TaskEvent,
  TaskEvidence,
  TaskHistoryPage,
  TaskInitializeInput,
  TaskItem,
  TaskMutationResult,
  TaskObjective,
  TaskProgress,
  TaskRescopeInput,
  TaskState,
  TaskStatus,
  TaskUpdateInput,
};
export { calculateTaskProgress };
