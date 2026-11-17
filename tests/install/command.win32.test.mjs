// platform-gate: win32-only
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { samePathIdentity } from '../../src/lib/path-identity.mjs';
import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { consumerProject, run } from '../support/install-command-harness.mjs';

after(cleanupTempDirs);

test('installer accepts Windows case and available 8.3 aliases for the same project root', (t) => {
  const fixture = consumerProject();
  const caseAlias = fixture.project.toUpperCase();
  assert.notEqual(caseAlias, fixture.project);
  const caseCheck = run(fixture, ['--check'], caseAlias);
  assert.equal(caseCheck.status, 1, `case-alias install --check: status=${caseCheck.status}, stderr=${caseCheck.stderr}, stdout=${caseCheck.stdout}`);
  assert.match(caseCheck.stdout, /Would register/, `case-alias install --check: status=${caseCheck.status}, stderr=${caseCheck.stderr}, stdout=${caseCheck.stdout}`);

  const shortPathScript = join(fixture.project, 'resolve-short-path.cmd');
  writeFileSync(shortPathScript, '@echo off\r\nfor %%I in ("%CD%") do @echo %%~sI\r\n');
  const shortPath = spawnSync('cmd.exe', ['/d', '/c', 'resolve-short-path.cmd'], { cwd: fixture.project, encoding: 'utf8' });
  rmSync(shortPathScript, { force: true });
  assert.equal(shortPath.error, undefined, `8.3 path query failed to start: ${shortPath.error?.message || ''}`);
  assert.equal(shortPath.status, 0, `8.3 path query failed: status=${shortPath.status}, stderr=${shortPath.stderr}, stdout=${shortPath.stdout}`);
  const shortAlias = shortPath.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(shortAlias, `8.3 path query returned no candidate: status=${shortPath.status}, stderr=${shortPath.stderr}, stdout=${shortPath.stdout}`);
  assert.ok(existsSync(shortAlias), `8.3 path candidate does not exist: ${JSON.stringify(shortAlias)}; stderr=${shortPath.stderr}, stdout=${shortPath.stdout}`);
  assert.ok(samePathIdentity(shortAlias, fixture.project), `8.3 path candidate is a different filesystem object: ${JSON.stringify(shortAlias)}; project=${fixture.project}`);
  if (!/(?:^|[\\/])[^\\/]*~\d+(?:[\\/]|$)/.test(shortAlias)) {
    t.diagnostic(`Windows did not provide an alternate 8.3 component for this fixture path; case-alias coverage passed. Candidate=${JSON.stringify(shortAlias)}`);
  } else {
    t.diagnostic(`Validated Windows 8.3 candidate: ${JSON.stringify(shortAlias)} (same filesystem identity as ${JSON.stringify(fixture.project)})`);
    const shortCheck = run(fixture, ['--check'], shortAlias);
    assert.equal(shortCheck.status, 1, `8.3-alias install --check: status=${shortCheck.status}, stderr=${shortCheck.stderr}, stdout=${shortCheck.stdout}`);
    assert.match(shortCheck.stdout, /Would register/, `8.3-alias install --check: status=${shortCheck.status}, stderr=${shortCheck.stderr}, stdout=${shortCheck.stdout}`);
  }
  assert.equal(existsSync(join(fixture.project, '.gitmodules')), false);
});
