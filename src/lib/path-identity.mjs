import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Compare existing filesystem objects by identity, including Windows 8.3 aliases. */
export function samePathIdentity(left, right) {
  try {
    if (process.platform === 'win32') {
      const leftStat = statSync(left, { bigint: true });
      const rightStat = statSync(right, { bigint: true });
      return leftStat.dev !== 0n && leftStat.ino !== 0n
        && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
    }
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return false;
  }
}

/**
 * Return whether target resolves at or below root. Root itself is within.
 * Missing target suffixes are allowed only when their deepest existing ancestor
 * can be proven to be inside root. Symlinks are followed, so an escape fails.
 */
export function isPathWithin(root, target) {
  try {
    const rootPath = resolve(root);
    const rootStat = statSync(rootPath, { bigint: true });
    if (!rootStat.isDirectory() || (process.platform === 'win32' && (rootStat.dev === 0n || rootStat.ino === 0n))) return false;
    const canonicalRoot = realpathSync.native(rootPath);

    const targetPath = resolve(target);
    let existing = targetPath;
    while (true) {
      try {
        lstatSync(existing);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') return false;
        const parent = dirname(existing);
        if (parent === existing) return false;
        existing = parent;
      }
    }

    // realpath follows symlinks and rejects dangling links or inaccessible paths.
    if (existing !== targetPath && !statSync(existing).isDirectory()) return false;
    let ancestor = realpathSync.native(existing);
    while (true) {
      if (samePathIdentity(canonicalRoot, ancestor)) return true;
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
  } catch {
    return false;
  }
}
