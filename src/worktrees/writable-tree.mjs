// Make the owner-owned, non-writable directories INSIDE one removal candidate writable.
// Consumers should pass a candidate that has already been validated by their own policy.
//
// Removing a directory entry needs write permission on its PARENT, so only directories
// need fixing; files are left alone. Every visited path is built from readdir names under
// `root`; symlinks are never followed or chmod-ed; directories owned by another uid are
// never touched; the walk stays on the root's device. Only u+rwx is added.

import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const OWNER_RWX = 0o700;

// -> { chmodded, foreign, symlinks, errors }
export function makeOwnedTreeWritable(root, { uid = typeof process.getuid === 'function' ? process.getuid() : -1 } = {}) {
  const result = { chmodded: 0, foreign: 0, symlinks: 0, errors: 0 };
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    // A vanished root has nothing to make writable; the removal that follows reports its own error.
    return result;
  }
  if (rootStat.isSymbolicLink()) {
    result.symlinks += 1;
    return result;
  }
  const stack = [{ path: root, stat: rootStat }];
  while (stack.length > 0) {
    const { path, stat } = stack.pop();
    if (stat.uid !== uid) {
      result.foreign += 1;
    } else if ((stat.mode & OWNER_RWX) !== OWNER_RWX) {
      try {
        chmodSync(path, (stat.mode & 0o7777) | OWNER_RWX);
        result.chmodded += 1;
      } catch {
        result.errors += 1;
        continue;
      }
    }
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      result.errors += 1;
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) { result.symlinks += 1; continue; }
      if (!entry.isDirectory()) continue;
      const child = join(path, entry.name);
      try {
        const childStat = lstatSync(child);
        if (childStat.isDirectory() && childStat.dev === rootStat.dev) stack.push({ path: child, stat: childStat });
      } catch {
        // The entry vanished mid-walk.
      }
    }
  }
  return result;
}
