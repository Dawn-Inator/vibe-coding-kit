import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(root, 'tests');
function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    return entry.isFile() && entry.name.endsWith('.test.mjs') ? [relative(testRoot, path).split(sep).join('/')] : [];
  }).sort();
}

const expected = JSON.parse(readFileSync(join(testRoot, 'manifest.json'), 'utf8'));
const actual = collect(testRoot);
if (actual.length === 0 || expected.length === 0) {
  console.error('[tests] refusing a green zero-test collection');
  process.exit(1);
}
if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
  console.error('[tests] tracked test manifest differs from collected files');
  console.error(`expected: ${expected.length}; found: ${actual.length}`);
  console.error(`missing: ${expected.filter((file) => !actual.includes(file)).join(', ') || '(none)'}`);
  console.error(`unlisted: ${actual.filter((file) => !expected.includes(file)).join(', ') || '(none)'}`);
  process.exit(1);
}
// Platform routing: `*.win32|posix|linux|darwin.test.mjs` files exercise real operating-system behavior and are
// selected by file name, not skipped inside the test. The first line declares the same gate, and a mismatch fails
// the run. Every file stays in the manifest, so the three-platform CI reaches each one on its own platform.
const GATES = {
  win32: { marker: 'win32-only', runsOn: (platform) => platform === 'win32' },
  posix: { marker: 'posix-only', runsOn: (platform) => platform !== 'win32' },
  linux: { marker: 'linux-only', runsOn: (platform) => platform === 'linux' },
  darwin: { marker: 'darwin-only', runsOn: (platform) => platform === 'darwin' },
};
export function platformGateOf(file) {
  const match = /\.(win32|posix|linux|darwin)\.test\.mjs$/u.exec(file);
  return match ? match[1] : null;
}
const gateErrors = [];
for (const file of actual) {
  const gate = platformGateOf(file);
  const header = readFileSync(join(testRoot, file), 'utf8').split(/\r?\n/u, 3).join('\n');
  const declared = /^\/\/ platform-gate: (\S+)$/mu.exec(header)?.[1] ?? null;
  if (gate && declared !== GATES[gate].marker) gateErrors.push(`${file}: expected "// platform-gate: ${GATES[gate].marker}" in its header, found ${declared ?? 'none'}`);
  if (!gate && declared) gateErrors.push(`${file}: declares platform-gate ${declared} but its name has no platform suffix`);
}
if (gateErrors.length) {
  console.error(`[tests] platform routing is inconsistent:\n${gateErrors.join('\n')}`);
  process.exit(1);
}
const selected = actual.filter((file) => {
  const gate = platformGateOf(file);
  return !gate || GATES[gate].runsOn(process.platform);
});
if (selected.length !== actual.length) console.log(`[tests] ${actual.length - selected.length} platform-routed file(s) are not for ${process.platform}`);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...selected.map((file) => join('tests', file))], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
