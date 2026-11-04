import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentRenderer, resolveBranchEnvironment, deepMerge } from '../../src/env-config/index.mjs';

test('consumer renders overlays deterministically and detects drift without writing', t => {
  const root = mkdtempSync(join(tmpdir(), 'kit-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  const paths = stage => ({ base: join(root, 'src/base.json'), overlay: join(root, `src/${stage}.json`), rendered: join(root, `out/${stage}.json`) });
  writeFileSync(paths('dev').base, JSON.stringify({ nested: { shared: 1, changed: 1 }, arr: [1], n: 2 }));
  writeFileSync(paths('dev').overlay, JSON.stringify({ nested: { changed: 2 }, arr: [3], n: null }));
  writeFileSync(paths('prod').overlay, '{}');
  const renderer = createEnvironmentRenderer({ stages: ['dev', 'prod'], paths, bannerKey: '_generated', bannerFor: stage => stage });
  assert.deepEqual(renderer.check(), ['dev', 'prod']);
  assert.deepEqual(renderer.regen(), ['dev', 'prod']);
  assert.deepEqual(JSON.parse(readFileSync(paths('dev').rendered, 'utf8')), { _generated: 'dev', nested: { shared: 1, changed: 2 }, arr: [3], n: null });
  assert.deepEqual(renderer.regen(), []);
  writeFileSync(paths('prod').rendered, 'drift');
  assert.deepEqual(renderer.check(), ['prod']);
  assert.equal(readFileSync(paths('prod').rendered, 'utf8'), 'drift');
  assert.throws(() => renderer.render('other'), /unknown/);
  writeFileSync(paths('dev').overlay, '{bad');
  assert.throws(() => renderer.regen(), /invalid JSON/);
  assert.equal(readFileSync(paths('prod').rendered, 'utf8'), 'drift');
  writeFileSync(paths('dev').overlay, '{"new":{"__proto__":{"polluted":true}}}');
  assert.throws(() => renderer.render('dev'), /unsafe key/);
  assert.equal({}.polluted, undefined);
});

test('branch mapping requires a known and consistent explicit source', () => {
  const config = { branches: { develop: 'dev', staging: 'stg', main: 'prod' }, environments: ['dev', 'stg', 'prod', 'local'] };
  assert.equal(resolveBranchEnvironment({ ...config, branch: 'develop' }), 'dev');
  assert.equal(resolveBranchEnvironment({ ...config, branch: 'staging' }), 'stg');
  assert.equal(resolveBranchEnvironment({ ...config, branch: 'main' }), 'prod');
  assert.equal(resolveBranchEnvironment({ ...config, environment: 'local' }), 'local');
  assert.throws(() => resolveBranchEnvironment({ ...config, branch: 'unknown' }), /unknown branch/);
  assert.throws(() => resolveBranchEnvironment({ ...config, branch: 'develop', environment: 'prod' }), /conflict/);
  assert.throws(() => resolveBranchEnvironment({ ...config, branches: { main: 'bad' }, branch: 'main' }), /invalid mapping/);
});


test('merge rejects dangerous keys in new and replaced nested values and arrays', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const hostile = JSON.parse(`{"x":[{"${key}":{}}]}`);
    assert.throws(() => deepMerge({}, hostile), /unsafe key/);
    assert.throws(() => deepMerge(hostile, {}), /unsafe key/);
    assert.throws(() => deepMerge({ x: 1 }, hostile), /unsafe key/);
  }
});
