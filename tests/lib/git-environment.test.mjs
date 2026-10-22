import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIT_REPOSITORY_SELECTION_ENV, sanitizedGitEnv } from '../../src/git-environment.mjs';

test('Git environment removes repository selectors while retaining auth, config, and system variables', () => {
  const input = {
    PATH: '/usr/bin',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'protocol.file.allow',
    GIT_CONFIG_VALUE_0: 'always',
    GIT_ASKPASS: '/tmp/askpass',
    GH_TOKEN: 'synthetic-token',
    GIT_DIR: '/foreign/repo/.git',
    GIT_WORK_TREE: '/foreign/repo',
    GIT_INDEX_FILE: '/foreign/index',
    GIT_COMMON_DIR: '/foreign/repo/.git',
    GIT_PREFIX: 'foreign/',
    GIT_CEILING_DIRECTORIES: '/foreign',
    git_dir: '/foreign/alias/.git',
    Git_Work_Tree: '/foreign/alias',
  };
  const result = sanitizedGitEnv(input);
  assert.notEqual(result, input);
  assert.deepEqual(input, {
    PATH: '/usr/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow',
    GIT_CONFIG_VALUE_0: 'always', GIT_ASKPASS: '/tmp/askpass', GH_TOKEN: 'synthetic-token',
    GIT_DIR: '/foreign/repo/.git', GIT_WORK_TREE: '/foreign/repo', GIT_INDEX_FILE: '/foreign/index',
    GIT_COMMON_DIR: '/foreign/repo/.git', GIT_PREFIX: 'foreign/', GIT_CEILING_DIRECTORIES: '/foreign',
    git_dir: '/foreign/alias/.git', Git_Work_Tree: '/foreign/alias',
  });
  for (const key of GIT_REPOSITORY_SELECTION_ENV) assert.equal(Object.hasOwn(result, key), false, key);
  assert.equal(Object.hasOwn(result, 'git_dir'), false);
  assert.equal(Object.hasOwn(result, 'Git_Work_Tree'), false);
  for (const key of ['PATH', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_ASKPASS', 'GH_TOKEN']) {
    assert.equal(result[key], input[key], key);
  }
});
