// platform-gate: posix-only
// Real symbolic link: a script started through a symlink must still count as the main module. Symlink creation can
// need elevated rights on Windows, so this file is routed to POSIX hosts by its name suffix.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../../optional/plugins/codex-task-progress/scripts/lib/main-module.mjs';

test('isMainModule is true when argv1 is a symlink to the module file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-main-module-link-'));
  try {
    const file = join(dir, 'entry.mjs');
    const link = join(dir, 'link.mjs');
    writeFileSync(file, '');
    symlinkSync(file, link);
    assert.equal(isMainModule(pathToFileURL(file).href, link), true);
    assert.equal(isMainModule(pathToFileURL(link).href, file), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
