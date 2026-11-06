import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
after(cleanupTempDirs);
import { planSecrets, createSecretRepository } from '../../src/secrets-setup.mjs';

const git = (cwd, ...args) => assert.equal(spawnSync('git', args, { cwd }).status, 0);
test('plans a private sibling repository from the project GitHub origin and refuses an occupied destination', () => {
  const tmp = mkdtempTracked('kit-secret-plan-');
  const root = join(tmp, 'local'); mkdirSync(root);
  git(root, 'init'); git(root, 'remote', 'add', 'origin', 'git@github.com:ExampleOrg/my-app.git');
  const plan = planSecrets(root, 'github');
  assert.deepEqual(plan, { method: 'github', repository: 'ExampleOrg/my-app-secret-key', localPath: '../my-app-secret-key' });
  mkdirSync(join(tmp, 'my-app-secret-key'));
  assert.throws(() => planSecrets(root, 'github'), /already exists/);
  assert.deepEqual(planSecrets(root, 'vault'), { method: 'vault', status: 'not-provisioned' });
  assert.throws(() => planSecrets(root, 'unknown'), /github or vault/);
});

test('creates only private GitHub repository and clones it; refuses non-private visibility', { skip: process.platform === 'win32' }, () => {
  const tmp = mkdtempTracked('kit-secret-create-');
  const root = join(tmp, 'app'); const bin = join(tmp, 'bin'); mkdirSync(root); mkdirSync(bin);
  const log = join(tmp, 'calls'); const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_GH_LOG"\nif [ "$1" = api ]; then printf "%s\\n" "${TEST_VISIBILITY:-private}"; fi\nif [ "$1" = repo ] && [ "$2" = clone ]; then mkdir "$4"; fi\n', { mode: 0o755 });
  const old = { PATH: process.env.PATH, TEST_GH_LOG: process.env.TEST_GH_LOG, TEST_VISIBILITY: process.env.TEST_VISIBILITY };
  process.env.PATH = `${bin}:${old.PATH}`; process.env.TEST_GH_LOG = log;
  try {
    const plan = { method: 'github', repository: 'owner/app-secret-key', localPath: '../app-secret-key' };
    createSecretRepository(root, plan);
    assert.ok(existsSync(join(tmp, 'app-secret-key')));
    assert.match(readFileSync(log, 'utf8'), /repo create owner\/app-secret-key --private/);
    assert.throws(() => createSecretRepository(root, plan), /already exists/);
    process.env.TEST_VISIBILITY = 'public';
    assert.throws(() => createSecretRepository(root, { ...plan, repository: 'owner/other-secret-key', localPath: '../other-secret-key' }), /visibility public/);
    assert.equal(existsSync(join(tmp, 'other-secret-key')), false);
  } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
