// platform-gate: posix-only
// Real-subprocess end-to-end coverage of the `install` command's own chain (spawn init, then configure optional
// components) with fake POSIX shell tools on PATH. tests/install/optional.test.mjs covers the same outcomes through
// injected host seams; this file proves the chain itself and runs only where the file name routes it.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import test, { after } from 'node:test';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { install, optionalConsumer } from '../support/optional-install-harness.mjs';

after(cleanupTempDirs);

test('optional setup-required exits nonzero and reports partial setup without discarding core initialization', () => {
  const fixture = optionalConsumer();
  const noOptionalTools = join(fixture.root, 'no-optional-tools');
  mkdirSync(noOptionalTools);
  for (const name of ['npm', 'lark-cli']) writeFileSync(join(noOptionalTools, name), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  const result = install(fixture, ['--optional=lark=on'], { ...process.env, PATH: `${noOptionalTools}${delimiter}${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Optional lark setup is incomplete \(setup-required\)/);
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), true);
  assert.equal(JSON.parse(readFileSync(join(fixture.project, '.vibe-coding/project.config.json'), 'utf8')).optional.lark, true);
});
