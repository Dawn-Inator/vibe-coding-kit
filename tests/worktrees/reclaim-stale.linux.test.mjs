// platform-gate: linux-only
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { liveProcessCwds } from '../../src/worktrees/reclaim-stale.mjs';

after(cleanupTempDirs);

test('without lsof, the live-process check falls back to /proc and still sees a process inside the worktree', async () => {
  const dir = realpathSync(mkdtempTracked('wtg-proc-cwd-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: dir, stdio: 'ignore' });
  const originalPath = process.env.PATH;
  try {
    await new Promise((resolveSpawn) => child.once('spawn', resolveSpawn));
    process.env.PATH = mkdtempTracked('wtg-empty-path-'); // no lsof on PATH -> spawnSync ENOENT
    const cwds = liveProcessCwds();
    assert.ok(cwds instanceof Set, 'the /proc fallback answered (null would mean the check was skipped)');
    assert.ok(cwds.has(dir), `the child's cwd ${dir} was found`);
  } finally {
    process.env.PATH = originalPath;
    child.kill('SIGKILL');
  }
});
