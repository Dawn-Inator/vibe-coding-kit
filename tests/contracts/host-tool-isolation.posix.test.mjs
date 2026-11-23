// platform-gate: posix-only
// Class defence for "a manifest test silently needs a host binary": the hygiene suite must pass with only the
// capabilities it declares on PATH (node, git, and go for the Go analyzer). gofmt, python3 and every other host
// tool are absent, so a test that reaches for one instead of an injected capability fails here, on every machine,
// not only on a runner that happens to lack the tool. Routed to posix by file name because it builds a PATH of symlinks.
import assert from 'node:assert/strict';
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const DECLARED_CAPABILITIES = ['git', 'go'];
const HYGIENE_TEST = fileURLToPath(new URL('../hygiene/check.test.mjs', import.meta.url));

function locate(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  throw new Error(`declared capability ${name} is not on PATH`);
}

test('the hygiene suite passes with only node, git and go on PATH', (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'host-tools-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const name of DECLARED_CAPABILITIES) symlinkSync(locate(name), join(bin, name));
  const run = spawnSync(process.execPath, ['--test', HYGIENE_TEST], {
    encoding: 'utf8',
    env: { PATH: bin, HOME: process.env.HOME ?? bin, TMPDIR: process.env.TMPDIR ?? tmpdir() },
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /# fail 0/u);
});
