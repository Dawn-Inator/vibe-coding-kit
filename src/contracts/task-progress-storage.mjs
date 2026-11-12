import { isAbsolute, resolve } from 'node:path';

export const TASK_PROGRESS_STORAGE_SCHEMA_VERSION = 2;
export const TASK_PROGRESS_STORAGE_DIRECTORY = 'codex-task-progress';
export const TASK_PROGRESS_CACHE_DIRECTORY = 'codex-task-progress';

/**
 * Resolve project-local durable and disposable task paths from the caller's trusted chat cwd.
 * This contract performs no I/O and deliberately does not find a parent Git root.
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
    cacheRoot: resolve(currentDirectory, '.tmp', TASK_PROGRESS_CACHE_DIRECTORY),
  });
}
