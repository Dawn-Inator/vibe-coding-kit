// Keep optional component coverage registered without making its dev toolchain
// a dependency of the Kit's core Node-only install.
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(
  new URL('../../optional/plugins/codex-task-progress/package.json', import.meta.url),
);

function hasModule(name) {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

if (hasModule('esbuild')) {
  await import('../../optional/plugins/codex-task-progress/tests/plugin-release.test.mjs');
} else {
  test('Task Progress release tests (optional esbuild)', {
    skip: 'optional Task Progress dev dependencies are not installed',
  }, () => {});
}

if (hasModule('esbuild') && hasModule('@playwright/test')) {
  await import('../../optional/plugins/codex-task-progress/tests/native-panel.test.mjs');
} else {
  test('Task Progress native-panel tests (optional Playwright toolchain)', {
    skip: 'optional Task Progress Playwright dev dependencies are not installed',
  }, () => {});
}
