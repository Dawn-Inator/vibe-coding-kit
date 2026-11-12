import { isAbsolute, resolve } from 'node:path';

export const TASK_PROGRESS_STORAGE_SCHEMA_VERSION = 1;
export const TASK_PROGRESS_STORAGE_DIRECTORY = 'codex-task-progress';

/**
 * Resolve project-local progress storage from the caller's trusted chat cwd.
 * This contract performs no I/O and deliberately does not find a parent Git root:
 * worktrees, nested projects and projectless chats keep their own workspace.
 */
export function resolveTaskProgressStorage({ cwd } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim() || !isAbsolute(cwd)) {
    throw new TypeError('Task progress storage requires an absolute, nonblank trusted cwd');
  }
  const currentDirectory = resolve(cwd);
  const workspaceRoot = resolve(currentDirectory, '.workspace');
  return Object.freeze({
    schemaVersion: TASK_PROGRESS_STORAGE_SCHEMA_VERSION,
    mode: 'workspace',
    cwd: currentDirectory,
    workspaceRoot,
    storageRoot: resolve(workspaceRoot, TASK_PROGRESS_STORAGE_DIRECTORY),
  });
}
