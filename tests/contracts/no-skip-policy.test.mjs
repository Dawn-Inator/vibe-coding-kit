import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
// Static scan of every manifest file, mirroring the consumer-side node-test skip policy: a platform or tool
// condition is expressed by injecting the capability (or by a platform-routed file name), never by skipping.
const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/gu;
const SKIP_SITE = /\.skip\(|\{\s*skip\s*:|^\s*skip\s*:/u;

test('no manifest test file contains a skip site', () => {
  const offenders = [];
  for (const file of manifest) {
    if (file === 'contracts/no-skip-policy.test.mjs') continue;
    readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split(/\r?\n/u).forEach((line, index) => {
      if (line.trimStart().startsWith('//')) return;
      if (SKIP_SITE.test(line.replace(STRING_LITERAL, "''"))) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
