import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';

after(cleanupTempDirs);

import {
  checkRepositoryLayout,
  layoutViolations,
  presentTrackedFiles,
  rootDirectories,
} from '../../src/layout/check-root-layout.mjs';

const ALLOWED_ROOT_DIRECTORIES = new Set([
  '.agents', '.claude', '.cursor', '.codex', '.github', '.husky', '.vibe-coding', '.script', 'engineering',
]);
const RETIRED_ROOT_DIRECTORIES = new Map([['scripts', 'engineering/automation']]);
const policy = { allowedRootDirectories: ALLOWED_ROOT_DIRECTORIES, retiredRootDirectories: RETIRED_ROOT_DIRECTORIES };

// No "self-check against this repo's real tracked files" test here on purpose:
// ALLOWED_ROOT_DIRECTORIES above is a starter template, not a description of
// whatever repository this file happens to sit in while you're still editing
// it — customize the set, then this test suite (plus a manual run of the CLI)
// is what tells you it's wired correctly for your own project.

test('checkRepositoryLayout throws with every violation on one message', () => {
  assert.throws(
    () => checkRepositoryLayout({ files: ['prototype/tmp.ts', 'engineering/automation/agent-worktrees/cli.mjs'], ...policy }),
    /prototype\/ is not classified/,
  );
  assert.doesNotThrow(() =>
    checkRepositoryLayout({ files: ['engineering/automation/agent-worktrees/cli.mjs'], ...policy }),
  );
});

test('rootDirectories extracts unique top-level directory names from tracked files', () => {
  assert.deepEqual(
    rootDirectories(['apps/mobile-client/package.json', 'apps/web-client/package.json', 'README.md']),
    ['apps'],
  );
});

test('unknown root directories fail closed', () => {
  assert.deepEqual(layoutViolations(['prototype/tmp.ts'], policy), [
    'prototype/ is not classified — declare its owner and lifecycle in your root-layout doc first',
  ]);
});

test('retired directories get a pointer to their replacement, not a generic error', () => {
  for (const [name, replacement] of RETIRED_ROOT_DIRECTORIES) {
    assert.deepEqual(layoutViolations([`${name}/dev-services/run.mjs`], policy), [
      `${name}/ is retired — use ${replacement} instead`,
    ]);
  }
});

test('every allowed directory passes with no violations', () => {
  for (const directory of ALLOWED_ROOT_DIRECTORIES) {
    assert.deepEqual(layoutViolations([`${directory}/anything.txt`], policy), [], directory);
  }
});

test('tracked-file filtering resolves against an explicit project root', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const projectRoot = mkdtempTracked('root-layout-');
  mkdirSync(join(projectRoot, 'apps'), { recursive: true });
  writeFileSync(join(projectRoot, 'apps', 'present.txt'), 'ok');
  assert.deepEqual(presentTrackedFiles(['apps/present.txt', 'apps/deleted.txt'], { projectRoot }), ['apps/present.txt']);
});
