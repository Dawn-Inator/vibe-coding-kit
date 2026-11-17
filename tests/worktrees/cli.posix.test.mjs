// platform-gate: posix-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { run, withCwd, withEnv, captureConsole, setUpFinishableWorktree, CROSS_PLATFORM_COMMAND } from '../support/worktree-cli-harness.mjs';
import { main } from '../../src/worktrees/cli.mjs';

test('git completion drains an ignored-stdio child after its parent exits without touching another process group', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wtg-group-drain-'));
  let unrelated;
  try {
    const { primaryDir, created, lockFile } = await setUpFinishableWorktree(tmp, 'group drain');
    const childPidFile = join(tmp, 'ignored-child.pid');
    const shellPath = (path) => path.replaceAll('\\', '/');
    const transport = `node ${shellPath(CROSS_PLATFORM_COMMAND)} spawn-ignored-child-and-exit ${shellPath(childPidFile)}`;
    run('git', ['remote', 'set-url', 'origin', `ext::${transport}`], primaryDir);
    const cfgPath = join(tmp, 'hold.json');
    writeFileSync(cfgPath, JSON.stringify({ queue: { maxHoldMs: 15000 } }));
    unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    unrelated.unref();

    const finishRun = await withEnv({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'protocol.ext.allow',
      GIT_CONFIG_VALUE_0: 'always',
    }, () => withCwd(created.path, () => captureConsole(() => (
      main(['finish', '--message', 'work', '--no-wait', '--config', cfgPath])
    ))));

    assert.equal(finishRun.result, 1, 'the transport returns no valid fetch response');
    assert.ok(existsSync(childPidFile), 'the ignored-stdio descendant started before its parent exited');
    const childPid = Number(readFileSync(childPidFile, 'utf8'));
    const childStillActive = () => {
      const state = spawnSync('ps', ['-o', 'stat=', '-p', String(childPid)], { encoding: 'utf8' });
      return state.status === 0 && !/^[ZX]/.test(String(state.stdout).trim());
    };
    assert.equal(childStillActive(), false, `the process-group drain must stop child pid=${childPid}`);
    assert.ok(unrelated.pid > 1);
    process.kill(unrelated.pid, 0);
    assert.equal(existsSync(lockFile), false, 'finish releases its lock after group drain');
    assert.equal(existsSync(created.path), true, 'failed fetch keeps the candidate worktree');
  } finally {
    if (unrelated?.pid) {
      try { unrelated.kill('SIGTERM'); } catch { /* already exited */ }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
