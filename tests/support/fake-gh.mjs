// A real Node executable under the gh name exercises spawn without platform shell shims.
import { constants, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

export function fakeGhEnvironment(root, { log, failClone = false, cloneGit = false, env = process.env } = {}) {
  const bin = join(root, 'fake-gh-bin');
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, process.platform === 'win32' ? 'gh.exe' : 'gh');
  if (process.platform === 'win32') copyFileSync(process.execPath, executable, constants.COPYFILE_FICLONE);
  const preload = join(root, 'fake-gh-preload.cjs');
  writeFileSync(preload, `
const path = require('node:path');
if (process.env.TEST_GH_INVOKED === '1' || /^gh(?:\\.exe)?$/i.test(path.basename(process.execPath))) {
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const args = process.argv.slice(process.env.TEST_GH_INVOKED === '1' ? 2 : 1);
  args[0] = path.basename(args[0]);
  if (process.env.TEST_GH_LOG) fs.appendFileSync(process.env.TEST_GH_LOG, args.join(' ') + '\\n');
  if (args[0] === 'api') console.log(args[1] === 'user' ? 'fixture-owner' : (process.env.TEST_VISIBILITY || 'private'));
  if (args[0] === 'repo' && args[1] === 'clone') {
    if (process.env.TEST_GH_FAIL_CLONE === '1') { console.error('clone-failed'); process.exit(1); }
    fs.mkdirSync(args[3]);
    if (process.env.TEST_GH_CLONE_GIT === '1') {
      for (const gitArgs of [['init', '-q'], ['remote', 'add', 'origin', 'https://github.com/' + args[2] + '.git']]) {
        const result = spawnSync('git', gitArgs, { cwd: args[3], stdio: 'inherit' });
        if (result.status !== 0) process.exit(result.status || 1);
      }
    }
  }
  process.exit(0);
}
`);
  if (process.platform !== 'win32') {
    const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
    writeFileSync(executable, `#!/bin/sh\nTEST_GH_INVOKED=1 exec ${quote(process.execPath)} ${quote(preload)} "$@"\n`, { mode: 0o755 });
  }
  return { ...env, PATH: `${bin}${delimiter}${env.PATH || ''}`, NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`.trim(), TEST_GH_LOG: log || '', TEST_GH_INVOKED: '0', TEST_GH_FAIL_CLONE: failClone ? '1' : '0', TEST_GH_CLONE_GIT: cloneGit ? '1' : '0' };
}
