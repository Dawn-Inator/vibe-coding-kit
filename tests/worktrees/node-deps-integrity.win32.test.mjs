// platform-gate: win32-only
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { configWith, makeTree } from '../support/node-deps-fixtures.mjs';
import { ensureNodeDepsMatchLockfile } from '../../src/worktrees/node-deps-integrity.mjs';

after(cleanupTempDirs);

test('Windows resolves the configured pnpm command through a real .cmd shim', () => {
  const root = makeTree();
  const bin = mkdtempTracked('wtg-windows-pnpm-bin-');
  const marker = join(root, 'pnpm-invoked.txt');
  writeFileSync(join(bin, 'pnpm.cmd'), `@echo off\r\n> "%WTG_PNPM_MARKER%" echo invoked\r\nexit /b 0\r\n`);
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
    WTG_PNPM_MARKER: marker,
  };
  const result = ensureNodeDepsMatchLockfile({
    worktreeRoot: root,
    config: configWith({ lockfile: 'package-lock.json', installCommand: 'pnpm install --frozen-lockfile' }),
    env,
    log: () => {},
  });
  assert.equal(result.status, 'installed', result.message);
  assert.equal(readFileSync(marker, 'utf8').trim(), 'invoked');
});
