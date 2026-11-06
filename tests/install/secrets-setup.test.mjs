import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';
after(cleanupTempDirs);
import { fakeGhEnvironment } from '../support/fake-gh.mjs';
import { planSecrets, createSecretRepository, verifySecretRepository } from '../../src/secrets-setup.mjs';

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

test('creates only private GitHub repository and clones it; refuses non-private visibility', () => {
  const tmp = mkdtempTracked("kit-secret-create-' space-");
  const root = join(tmp, 'app'); mkdirSync(root);
  const log = join(tmp, 'calls');
  const old = { ...process.env };
  Object.assign(process.env, fakeGhEnvironment(tmp, { log }));
  try {
    const plan = { method: 'github', repository: 'owner/app-secret-key', localPath: '../app-secret-key' };
    createSecretRepository(root, plan);
    assert.ok(existsSync(join(tmp, 'app-secret-key')));
    const clone = join(tmp, 'app-secret-key');
    git(clone, 'init');
    git(clone, 'remote', 'add', 'origin', 'https://github.com/owner/app-secret-key.git');
    for (const remote of ['https://github.com/owner/app-secret-key.git', 'git@github.com:owner/app-secret-key.git', 'ssh://git@github.com/owner/app-secret-key.git']) {
      git(clone, 'remote', 'set-url', 'origin', remote);
      assert.doesNotThrow(() => verifySecretRepository(root, plan), remote);
    }
    git(clone, 'remote', 'set-url', 'origin', 'https://github.com/other/app-secret-key.git');
    assert.throws(() => verifySecretRepository(root, plan), /does not match/);
    assert.match(readFileSync(log, 'utf8'), /repo create owner\/app-secret-key --private/);
    assert.throws(() => createSecretRepository(root, plan), /already exists/);
    process.env.TEST_VISIBILITY = 'public';
    assert.throws(() => createSecretRepository(root, { ...plan, repository: 'owner/other-secret-key', localPath: '../other-secret-key' }), /visibility public/);
    assert.equal(existsSync(join(tmp, 'other-secret-key')), false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
