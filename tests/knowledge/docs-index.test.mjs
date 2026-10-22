import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sync, check, escapeLinkText } from '../../src/knowledge/docs/docs-index.mjs';

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'docs-index-test-'));
}

function writeFile(path, content) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function frontmatter({ title, description, authority }) {
  return `---\ntitle: ${title}\ndescription: ${description}\nauthority: ${authority}\n---\n\n# ${title}\n\nBody text.\n`;
}

function seedValidRepo(root) {
  writeFile(
    join(root, 'doc', 'a-hard.md'),
    frontmatter({ title: 'Hard Doc', description: 'A hard rule doc.', authority: 'hard' }),
  );
  writeFile(
    join(root, 'doc', 'b-normal.md'),
    frontmatter({ title: 'Normal Doc', description: 'A normal doc.', authority: 'normal' }),
  );
  writeFile(
    join(root, 'doc', 'sub', 'README.md'),
    frontmatter({ title: 'Sub Collection', description: 'A collection doc.', authority: 'normal' }),
  );
}

test('sync generates correctly grouped and sorted index', () => {
  const root = makeTempRoot();
  seedValidRepo(root);

  const result = sync({ root });
  assert.equal(result.changed, true);

  const rendered = readFileSync(join(root, 'doc', 'README.md'), 'utf8');

  assert.ok(rendered.includes('# Doc Index'));
  assert.ok(rendered.includes('## 硬约定 · 触发对应场景必须先读'));
  assert.ok(rendered.includes('## 其余文档'));

  assert.ok(rendered.includes('[Hard Doc](a-hard.md) — A hard rule doc.'));
  assert.ok(rendered.includes('[Normal Doc](b-normal.md) — A normal doc.'));
  assert.ok(rendered.includes('[Sub Collection](sub/README.md) — A collection doc.'));

  // Hard Doc appears in the hard section, not the "其余文档" section.
  const hardSectionIdx = rendered.indexOf('## 硬约定');
  const restSectionIdx = rendered.indexOf('## 其余文档');
  const hardDocIdx = rendered.indexOf('[Hard Doc]');
  assert.ok(hardDocIdx > hardSectionIdx && hardDocIdx < restSectionIdx);

  // b-normal.md sorts before sub/README.md by linkPath.
  const normalIdx = rendered.indexOf('[Normal Doc]');
  const subIdx = rendered.indexOf('[Sub Collection]');
  assert.ok(normalIdx < subIdx);

  // running sync again is a no-op (idempotent, byte-identical)
  const second = sync({ root });
  assert.equal(second.changed, false);

  rmSync(root, { recursive: true, force: true });
});

test('check reports a clear problem with the offending path for invalid frontmatter', () => {
  const root = makeTempRoot();
  seedValidRepo(root);
  writeFile(join(root, 'doc', 'c-bad.md'), '---\ntitle: Bad Doc\nauthority: hard\n---\n\nMissing description.\n');

  const result = check({ root });
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.problems.some((p) => p.includes('c-bad.md') && p.toLowerCase().includes('description')),
    `expected a description-related problem naming c-bad.md, got: ${JSON.stringify(result.problems)}`,
  );

  rmSync(root, { recursive: true, force: true });
});

test('sync refuses to write when frontmatter validation fails', () => {
  const root = makeTempRoot();
  seedValidRepo(root);
  writeFile(join(root, 'doc', 'c-bad.md'), '---\ntitle: Bad Doc\nauthority: not-a-real-value\n---\n\nBody.\n');

  assert.throws(() => sync({ root }), /problem/);

  rmSync(root, { recursive: true, force: true });
});

test('check detects a dead link in the generated doc/README.md', () => {
  const root = makeTempRoot();
  seedValidRepo(root);
  sync({ root });

  const readmePath = join(root, 'doc', 'README.md');
  const current = readFileSync(readmePath, 'utf8');
  writeFileSync(readmePath, `${current}\n- [Ghost Doc](does-not-exist.md) — dangling link.\n`, 'utf8');

  const result = check({ root });
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.problems.some((p) => p.includes('dead link') && p.includes('does-not-exist.md')),
    `expected a dead link problem, got: ${JSON.stringify(result.problems)}`,
  );

  rmSync(root, { recursive: true, force: true });
});

test('escapeLinkText escapes backslashes before brackets, in order', () => {
  // A title ending in a backslash followed by a right-bracket-sensitive
  // sequence must not be able to prematurely close the markdown link.
  const title = 'Weird Title\\ [gotcha]';
  const escaped = escapeLinkText(title);

  assert.equal(escaped, 'Weird Title\\\\ [gotcha\\]');
  // Reconstructing a markdown link with this text must not contain an
  // unescaped "](" sequence introduced by the title itself.
  const link = `[${escaped}](somewhere.md)`;
  assert.equal(link, '[Weird Title\\\\ [gotcha\\]](somewhere.md)');
});

test('collection directory missing README.md is reported as a problem', () => {
  const root = makeTempRoot();
  seedValidRepo(root);
  mkdirSync(join(root, 'doc', 'orphan-collection'), { recursive: true });

  const result = check({ root });
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.problems.some((p) => p.includes('orphan-collection') && p.toLowerCase().includes('readme')),
    `expected a missing-README problem for orphan-collection, got: ${JSON.stringify(result.problems)}`,
  );

  rmSync(root, { recursive: true, force: true });
});

test('generated index contains no project branding', () => {
  const root = makeTempRoot();
  seedValidRepo(root);
  sync({ root });

  const rendered = readFileSync(join(root, 'doc', 'README.md'), 'utf8');
  assert.ok(!/lingofly/i.test(rendered), 'generated doc/README.md must not mention any project brand name');
  assert.ok(rendered.startsWith('<!-- GENERATED by scripts/docs-index.mjs.'));
  assert.ok(rendered.includes('# Doc Index'));

  rmSync(root, { recursive: true, force: true });
});
