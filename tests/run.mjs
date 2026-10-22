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
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...actual.map((file) => join('tests', file))], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
