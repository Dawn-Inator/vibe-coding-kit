// Project-independent root-directory-layout mechanism. Callers own the taxonomy and
// must pass the root being checked explicitly; module location never determines a repo.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function trackedFiles(projectRoot = process.cwd()) {
  const result = execFileSync('git', ['ls-files', '-z'], {
    cwd: resolve(projectRoot),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = result.split('\0').filter(Boolean);
  if (files.length === 0) {
    throw new Error('[check-root-layout] `git ls-files` returned nothing — is this actually a git repository?');
  }
  return files;
}

export function presentTrackedFiles(files, { projectRoot = process.cwd() } = {}) {
  const root = resolve(projectRoot);
  return files.filter((file) => existsSync(resolve(root, file)));
}

export function rootDirectories(files) {
  return [...new Set(files.filter((file) => file.includes('/')).map((file) => file.split('/')[0]))].sort();
}

export function layoutViolations(files, {
  allowedRootDirectories = new Set(),
  retiredRootDirectories = new Map(),
  formatRetired = (directory, replacement) => `${directory}/ is retired — use ${replacement} instead`,
  formatUnclassified = (directory) => `${directory}/ is not classified — declare its owner and lifecycle in your root-layout doc first`,
} = {}) {
  return rootDirectories(files).flatMap((directory) => {
    if (allowedRootDirectories.has(directory)) return [];
    const replacement = retiredRootDirectories.get(directory);
    return replacement
      ? [formatRetired(directory, replacement)]
      : [formatUnclassified(directory)];
  });
}

export function checkRepositoryLayout({
  files,
  projectRoot = process.cwd(),
  allowedRootDirectories = new Set(),
  retiredRootDirectories = new Map(),
  formatRetired = (directory, replacement) => `${directory}/ is retired — use ${replacement} instead`,
  formatUnclassified = (directory) => `${directory}/ is not classified — declare its owner and lifecycle in your root-layout doc first`,
  formatError = (violations) => `[check-root-layout] ${violations.length} violation(s):\n  ${violations.join('\n  ')}`,
} = {}) {
  const currentFiles = files ?? trackedFiles(projectRoot);
  const violations = layoutViolations(currentFiles, {
    allowedRootDirectories,
    retiredRootDirectories,
    formatRetired,
    formatUnclassified,
  });
  if (violations.length > 0) throw new Error(formatError(violations));
}
