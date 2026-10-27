import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkBackendArchitecture } from '../../src/backend/dispatch.mjs';
import { runProjectHook } from '../../src/contracts/project-adapter.mjs';

const cli = fileURLToPath(new URL('../../cli.mjs', import.meta.url));
function fixture(t, language) {
  const root = mkdtempSync(join(tmpdir(), 'backend cli '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.vibe-coding'));
  mkdirSync(join(root, 'domains', 'orders'), { recursive: true });
  const config = { schemaVersion: 1, language, services: [{ root: 'domains', module: language === 'go' ? 'example.com/domains' : 'domains' }] };
  const save = () => writeFileSync(join(root, '.vibe-coding/backend-architecture.json'), JSON.stringify(config));
  save();
  const put = (name, value) => writeFileSync(join(root, 'domains/orders', name), value);
  return { root, config, save, put };
}

for (const [language, name, good, bad] of [
  ['python', 'service.py', 'def run() -> str:\n    return "ok"\n', 'def run(session):\n    session.execute("SELECT 1")\n'],
  ['typescript', 'service.ts', 'export function run(): string { return "ok"; }', 'export function run(db: any): void { db.query("SELECT 1"); }'],
  ['go', 'service.go', 'package orders\nfunc Run() string { return "ok" }\n', 'package orders\nfunc Run(db DB) { db.Query("SELECT 1") }\n'],
]) {
  test(`public CLI dispatches ${language}, emits findings and returns failure`, async t => {
    const f = fixture(t, language);
    f.put(name, good);
    const result = await checkBackendArchitecture({ projectRoot: f.root });
    assert.equal(result.ok, true);
    assert.equal(result.engine, language);
    assert.ok(result.filesScanned > 0);
    f.put(name, bad);
    const run = spawnSync(process.execPath, [cli, 'backend-check', '--project-root', f.root], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.findings.some(finding => finding.rule === 'sql-slot'));
  });
}

test('unknown languages, missing config and invalid source never become skipped success', async t => {
  const f = fixture(t, 'rust');
  await assert.rejects(checkBackendArchitecture({ projectRoot: f.root }), /Unsupported backend language/);
  f.config.language = 'python'; f.save();
  f.put('service.py', 'def broken(\n');
  await assert.rejects(checkBackendArchitecture({ projectRoot: f.root }), /analyzer failed/);
  await assert.rejects(checkBackendArchitecture({ projectRoot: f.root, configPath: 'absent.json' }), /ENOENT/);
});

test('a project adapter rejects an actual backend violation before push', async t => {
  const f = fixture(t, 'python');
  const api = new URL('../../src/backend/dispatch.mjs', import.meta.url).href;
  writeFileSync(join(f.root, '.vibe-coding/project.config.json'), JSON.stringify({ schemaVersion: 1, adapter: 'adapter.mjs' }));
  writeFileSync(join(f.root, 'adapter.mjs'), `
    import { checkBackendArchitecture } from ${JSON.stringify(api)};
    export const adapterContract = { schemaVersion: 1, hooks: { beforePush: 'verify' } };
    export async function verify({ projectRoot }) { return checkBackendArchitecture({ projectRoot }); }
  `);
  f.put('service.py', 'def run() -> str:\n    return "ok"\n');
  assert.equal((await runProjectHook({ projectRoot: f.root, phase: 'beforePush' })).ran, true);
  f.put('service.py', 'def run(session):\n    session.execute("SELECT 1")\n');
  await assert.rejects(runProjectHook({ projectRoot: f.root, phase: 'beforePush' }), /rejected the operation/);
});
