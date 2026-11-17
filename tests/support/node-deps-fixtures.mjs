import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/worktrees/config.mjs';
import { mkdtempTracked } from './temp-dirs.mjs';

export function configWith(nodeDeps, extra = {}) {
  return { ...DEFAULT_CONFIG, nodeDeps, ...extra };
}

export function makeTree(lock = 'lock v1\n') {
  const root = mkdtempTracked('wtg-node-deps-');
  writeFileSync(join(root, 'package-lock.json'), lock);
  return root;
}
