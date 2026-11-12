import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMarkdownRecords, writeMarkdownRecords, withMarkdownLock } from '../../src/tasks/markdown-records.mjs';
test('Markdown records validate identity and serialize writes', async () => {
 const root = await mkdtemp(join(tmpdir(), 'md-record-')); const path = join(root, 'history.md');
 try {
  assert.equal((await readMarkdownRecords(path, {kind:'kind', identity:'id'})).exists, false);
  await writeMarkdownRecords(path, {kind:'kind', identity:'id', records:[{a:1}]});
  assert.match(await readFile(path, 'utf8'), /^# kind/m);
  assert.deepEqual((await readMarkdownRecords(path, {kind:'kind', identity:'id'})).records, [{a:1}]);
  await assert.rejects(readMarkdownRecords(path, {kind:'kind', identity:'wrong'}));
  const order = []; await Promise.all([1,2].map(i => withMarkdownLock(path, async () => { order.push(i); await Promise.resolve(); order.push(i); })));
  assert.deepEqual(order, [1,1,2,2]);
  await writeFile(path, 'corrupt'); await assert.rejects(readMarkdownRecords(path, {kind:'kind', identity:'id'}));
 } finally { await rm(root, {recursive:true, force:true}); }
});
