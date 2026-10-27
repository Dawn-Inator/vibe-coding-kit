import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflowsDir = new URL('../../.github/workflows/', import.meta.url);
const ci = readFileSync(new URL('ci.yml', workflowsDir), 'utf8');

test('CI installs Go on every runner before the backend analyzer toolchains are used', () => {
  const setupGo = ci.indexOf('uses: actions/setup-go@');
  const toolchains = ci.indexOf('- name: Record backend analyzer toolchains');
  const manifest = ci.indexOf('run: node tests/run.mjs');
  assert.ok(setupGo >= 0, 'ci.yml sets up Go explicitly instead of relying on the runner image');
  assert.ok(setupGo < toolchains && toolchains < manifest);
  assert.doesNotMatch(ci.slice(0, ci.indexOf('steps:')), /if:/u, 'the toolchain setup applies to every matrix runner');
});

test('every workflow pins third-party actions to a full commit SHA', () => {
  for (const name of readdirSync(workflowsDir).filter((file) => file.endsWith('.yml'))) {
    const workflow = readFileSync(new URL(name, workflowsDir), 'utf8');
    for (const [, ref] of workflow.matchAll(/uses: ([^\s#]+)/gu)) {
      assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u, `${name}: ${ref} is pinned to a commit SHA`);
    }
  }
});

test('CI runs only for main pushes and pull requests into main', () => {
  const trigger = ci.slice(ci.indexOf('\non:'), ci.indexOf('\npermissions:'));
  assert.match(trigger, /push:\s+branches:\s+- main\s+pull_request:\s+branches:\s+- main\s*$/u);
});
