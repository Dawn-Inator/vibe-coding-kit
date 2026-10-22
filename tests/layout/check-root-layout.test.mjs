import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
import { gitOut } from '../support/git-fixture.mjs';

after(cleanupTempDirs);

import {
  checkRepositoryLayout,
  layoutViolations,
  presentTrackedFiles,
  rootDirectories,
  trackedFiles,
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
  const projectRoot = mkdtempTracked('root-layout-');
  mkdirSync(join(projectRoot, 'apps'), { recursive: true });
  writeFileSync(join(projectRoot, 'apps', 'present.txt'), 'ok');
  assert.deepEqual(presentTrackedFiles(['apps/present.txt', 'apps/deleted.txt'], { projectRoot }), ['apps/present.txt']);
});

test('trackedFiles stays bound to the explicit project when hook Git env selects another repository', () => {
  const projectRoot = mkdtempTracked('root-layout-project-');
  const foreignRoot = mkdtempTracked('root-layout-foreign-');
  mkdirSync(join(projectRoot, 'apps'), { recursive: true });
  mkdirSync(join(foreignRoot, 'foreign'), { recursive: true });
  writeFileSync(join(projectRoot, 'apps', 'project.txt'), 'project\n');
  writeFileSync(join(foreignRoot, 'foreign', 'other.txt'), 'foreign\n');
  for (const root of [projectRoot, foreignRoot]) {
    gitOut(['init', '-q', '--initial-branch=main'], root);
    gitOut(['add', '.'], root);
    gitOut(['commit', '-qm', 'fixture'], root);
  }

  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    process.env.GIT_DIR = join(foreignRoot, '.git');
    process.env.GIT_WORK_TREE = foreignRoot;
    process.env.GIT_INDEX_FILE = join(foreignRoot, '.git', 'index');
    process.env.GIT_COMMON_DIR = join(foreignRoot, '.git');
    process.env.GIT_PREFIX = 'foreign/';
    process.env.GIT_CEILING_DIRECTORIES = foreignRoot;
    assert.deepEqual(trackedFiles(projectRoot), ['apps/project.txt']);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
