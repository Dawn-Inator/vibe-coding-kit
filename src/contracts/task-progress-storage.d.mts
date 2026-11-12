export const TASK_PROGRESS_STORAGE_SCHEMA_VERSION: 1;
export const TASK_PROGRESS_STORAGE_DIRECTORY: 'codex-task-progress';

export interface TaskProgressStoragePaths {
  readonly schemaVersion: 1;
  readonly mode: 'workspace';
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly storageRoot: string;
}

/** Pure path resolution from an absolute trusted chat cwd; performs no I/O. */
export function resolveTaskProgressStorage(options: { cwd: string }): TaskProgressStoragePaths;
