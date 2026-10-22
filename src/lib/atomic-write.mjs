// Shared atomic-write helper used by the index/sync scripts (docs-index.mjs,
// memory-index.mjs, history-index.mjs, sync-skills.mjs). Writing to a temp file
// in the same directory and renaming avoids a reader ever observing a
// half-written file, since rename(2) within one filesystem is atomic.

import { writeFileSync, renameSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeTextAtomically(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, content, 'utf8');
  if (mode !== undefined) {
    chmodSync(tmpPath, mode);
  }
  renameSync(tmpPath, path);
}
