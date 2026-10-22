// Repository-selection variables can redirect a Git command away from its
// explicit cwd. Strip those selectors while preserving credentials and config.
export const GIT_REPOSITORY_SELECTION_ENV = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
]);

export function sanitizedGitEnv(env = process.env) {
  const result = { ...env };
  const blocked = new Set(GIT_REPOSITORY_SELECTION_ENV);
  for (const key of Object.keys(result)) {
    if (blocked.has(key.toUpperCase())) delete result[key];
  }
  return result;
}
