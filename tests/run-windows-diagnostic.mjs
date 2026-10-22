import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(root, 'tests');
const groups = new Map([
  ['1', new Set(['contracts', 'dependencies', 'install', 'lib', 'skills'])],
  ['2', new Set(['worktrees'])],
  ['3', new Set(['supervision', 'knowledge', 'layout'])],
]);

function collect(directory, rootDirectory = testRoot) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path, rootDirectory);
    return entry.isFile() && entry.name.endsWith('.test.mjs') ? [relative(rootDirectory, path).split(sep).join('/')] : [];
  }).sort();
}

export function filesForGroup(manifest, groupId) {
  const prefixes = groups.get(groupId);
  if (!prefixes) throw new Error(`unsupported Windows diagnostic group: ${groupId}`);
  if (!Array.isArray(manifest) || manifest.length === 0 || manifest.some((file) => typeof file !== 'string' || !file.endsWith('.test.mjs') || file.startsWith('/') || file.split('/').includes('..'))) {
    throw new Error('test manifest must be a non-empty list of .test.mjs paths');
  }
  if (new Set(manifest).size !== manifest.length) throw new Error('test manifest contains duplicate paths');
  const assigned = new Map();
  for (const file of manifest) {
    const prefix = file.split('/')[0];
    const group = [...groups].find(([, allowed]) => allowed.has(prefix))?.[0];
    if (!group) throw new Error(`test manifest path has no Windows diagnostic group: ${file}`);
    assigned.set(file, group);
  }
  const selected = manifest.filter((file) => assigned.get(file) === groupId);
  if (selected.length === 0) throw new Error(`Windows diagnostic group ${groupId} has zero tests`);
  return selected;
}

export function main(argv = process.argv.slice(2), { spawn = spawnSync, cwd = root, log = console.log, error = console.error } = {}) {
  if (argv.length !== 1 || !groups.has(argv[0])) {
    error('usage: node tests/run-windows-diagnostic.mjs <1|2|3>');
    return 2;
  }
  const manifestPath = join(cwd, 'tests/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const expected = [...manifest].sort();
  const actual = collect(join(cwd, 'tests'), join(cwd, 'tests'));
  if (actual.length === 0 || JSON.stringify(actual) !== JSON.stringify(expected)) {
    error(`[windows-diagnostic] test manifest mismatch; expected=${expected.length}, found=${actual.length}`);
    error(`missing: ${expected.filter((file) => !actual.includes(file)).join(', ') || '(none)'}`);
    error(`unlisted: ${actual.filter((file) => !expected.includes(file)).join(', ') || '(none)'}`);
    return 1;
  }
  const selected = filesForGroup(manifest, argv[0]);
  log(`[windows-diagnostic] group=${argv[0]} tests=${selected.length}`);
  const result = spawn(process.execPath, ['--test', '--test-concurrency=1', ...selected.map((file) => join('tests', file))], {
    cwd,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
