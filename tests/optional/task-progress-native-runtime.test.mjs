// Keep native-only plugin tests selected without requiring its dev toolchain in Kit core.
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(
  new URL('../../optional/plugins/codex-task-progress/package.json', import.meta.url),
);

let hasTsx = true;
let tsxApi;
try { tsxApi = require.resolve('tsx/esm/api'); } catch { hasTsx = false; }

if (hasTsx) {
  const { register } = await import(pathToFileURL(tsxApi).href);
  register();
  await import('../../optional/plugins/codex-task-progress/tests/native-installer-contract.test.mjs');
  await import('../../optional/plugins/codex-task-progress/packages/host/test/native-only.test.ts');
} else {
  test('Task Progress native-only installer and Helper tests (optional tsx toolchain)', {
    skip: 'optional Task Progress dev dependencies are not installed',
  }, () => {});
}

// The source launcher suite is Node-only and skips internally when its optional
// package dependencies are not installed.
await import('../../optional/plugins/codex-task-progress/tests/source-launcher.test.mjs');
