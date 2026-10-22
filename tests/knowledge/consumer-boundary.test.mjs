import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeFiles = [
  'src/knowledge/docs/docs-index.mjs',
  'src/knowledge/history/history-index.mjs',
  'src/knowledge/memory/memory-index.mjs',
];

test('public knowledge runtimes do not import or encode a consumer project policy', () => {
  for (const relativePath of runtimeFiles) {
    const source = readFileSync(join(root, relativePath), 'utf8');
    assert.doesNotMatch(source, /LingoFly|engineering\/automation|doc\/ai-memory-notes/);
    assert.doesNotMatch(source, /from\s+['"][^'"]*\.agents\//);
  }
});

test('default consumer roots come from cwd or explicit roots, never the kit module URL', () => {
  for (const relativePath of runtimeFiles) {
    const source = readFileSync(join(root, relativePath), 'utf8');
    assert.doesNotMatch(source, /resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\)/);
  }
});
