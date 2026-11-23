// platform-gate: posix-only
// Real dangling-symlink proof that heartbeat ledger creation refuses to publish through a link at the head or a
// companion path. Creating file symlinks needs extra privileges on Windows, so this file is routed to POSIX hosts by
// its name; the remaining heartbeat ledger file cases live in heartbeat-ledger-files.test.mjs.
import assert from 'node:assert/strict';
import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createHeartbeatLedgerPair, heartbeatLedgerPairPaths } from '../../src/supervision/heartbeat-ledger-files.mjs';
import { cleanupTempDirs, mkdtempTracked } from '../support/temp-dirs.mjs';

after(cleanupTempDirs);

const wake = (time) => `## ${time} wake (10-row ledger)\nsources: x(ok)\n`;

test('creation refuses dangling head and companion symlinks', () => {
  for (const target of ['headPath', 'historyPath', 'legacyBackupPath']) {
    const dir = mkdtempTracked('heartbeat-pair-');
    const path = join(dir, 'heartbeat.md');
    const missing = join(dir, 'missing.md');
    symlinkSync(missing, heartbeatLedgerPairPaths(path)[target]);
    assert.throws(() => createHeartbeatLedgerPair({
      root: dir, path, text: wake('2026-01-01T10:00Z'), legacyWritersQuiescent: true,
    }), /absent/i, target);
    assert.equal(existsSync(missing), false, target);
    assert.equal(existsSync(path), false, target);
  }
});
