// The Task Progress plugin's dev toolchain (esbuild, tsx, Playwright, ...) is a required test dependency,
// not an optional one: a missing package fails the suite with install instructions instead of skipping it.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const PLUGIN_PACKAGE = new URL('../../optional/plugins/codex-task-progress/package.json', import.meta.url);

export function requireTaskProgressToolchain(...specifiers) {
  const require = createRequire(PLUGIN_PACKAGE);
  const missing = specifiers.filter((specifier) => {
    try { require.resolve(specifier); return false; } catch { return true; }
  });
  if (missing.length) {
    throw new Error(
      `Task Progress test toolchain is not installed (missing: ${missing.join(', ')}). ` +
      'Install it with `pnpm install --frozen-lockfile` in optional/plugins/codex-task-progress, ' +
      'then `pnpm exec playwright install chromium` for the native-panel browser tests.',
    );
  }
  return require;
}

// Imports a toolchain entry point resolved from the plugin package, so the dependency stays owned by the
// plugin's package.json rather than by whichever test file wraps the plugin suite.
export async function importTaskProgressToolchainModule(specifier) {
  const require = requireTaskProgressToolchain(specifier);
  return import(pathToFileURL(require.resolve(specifier)).href);
}
