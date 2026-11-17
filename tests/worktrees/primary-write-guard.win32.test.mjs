// platform-gate: win32-only
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { cleanupTempDirs } from '../support/temp-dirs.mjs';
import { fixture, write } from '../support/primary-guard-fixture.mjs';

after(cleanupTempDirs);

test('Windows drive/case aliases still resolve to the protected primary tree', () => {
  const { primary } = fixture();
  const casingAlias = primary.replace(/[a-z]/g, (letter, index) => (index % 2 === 0 ? letter.toUpperCase() : letter));
  assert.notEqual(casingAlias, primary);
  assert.equal(write(join(casingAlias, 'new-dir', 'file.txt'), casingAlias).allow, false);
});
