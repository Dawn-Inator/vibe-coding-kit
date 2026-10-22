import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseSkillDescription,
  rewriteLinksFromMirror,
  rewriteLinksToMirror,
  splitSkillRel,
} from '../../src/skills/skill-pack-mirror.mjs';
import { overrideSkillPacks, packOf, SKILL_PACKS, validateSkillPacks } from '../../src/skills/skill-packs.mjs';

// Skill-pack mirroring end to end against a disposable `--root` fixture. The shipped SKILL_PACKS is
// empty, so the fixture injects its own registry through `--skill-packs-config` (only honored
// together with `--root`, see skill-packs.mjs).

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../src/skills/sync-skills.mjs');
const SPAWN_TIMEOUT_MS = 60_000;

const SKILL_FILES = {
  'demo/SKILL.md':
    '---\nname: demo\ndescription: "Demo entry. Second sentence."\n---\n\n# demo\n\nSee [a ref](../demo-a/references/x.md).\n',
  'demo-a/SKILL.md':
    '---\nname: demo-a\ndescription: "Alpha member，做 A 事。其它。"\n---\n\n# demo-a\n\n' +
    'Sibling [b](../demo-b/SKILL.md), plain [p](../plain/SKILL.md), own [x](references/x.md), [y](./references/y.md),\n' +
    'doc [d](../../../doc/x.md), web [w](https://example.com/a), anchor [h](#top).\n\n' +
    '```md\n[fenced](../plain/SKILL.md)\n```\n',
  'demo-a/references/x.md': '# x\n',
  'demo-a/references/y.md':
    '# y\n\nBack to [plain](../../plain/SKILL.md#sec) and [up](../SKILL.md).\n',
  'demo-b/SKILL.md':
    '---\nname: demo-b\ndescription: >\n  Bravo member | pipe.\n  more text\n---\n\n# demo-b\n',
  'plain/SKILL.md':
    '---\nname: plain\ndescription: plain skill\n---\n\n# plain\n\nGo to [a](../demo-a/SKILL.md) or [entry](../demo/SKILL.md).\n',
};

function createFixtureRoot(extraSkills = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skill-packs-test-'));
  mkdirSync(join(root, '.vibe-coding/skills'), { recursive: true });
  writeFileSync(join(root, '.vibe-coding/loading.md'), '# fixture loading.md\n');
  for (const [rel, text] of Object.entries({ ...SKILL_FILES, ...extraSkills })) {
    const abs = join(root, '.vibe-coding/skills', rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  writeFileSync(
    join(root, 'packs.json'),
    JSON.stringify([
      { id: 'demo', entry: 'demo', members: ['demo-a', 'demo-b'], memberPrefix: 'demo-' },
    ]),
  );
  return root;
}

function run(root, args) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, ...args, '--root', root, '--skill-packs-config', join(root, 'packs.json')],
    { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS },
  );
  assert.equal(result.error, undefined, `sync-skills ${args.join(' ')} did not run: ${result.error}`);
  assert.notEqual(result.status, null, `sync-skills ${args.join(' ')} was killed (${result.signal})`);
  return result;
}

function runOk(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[abs.slice(dir.length)] = readFileSync(abs, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function withFixture(fn, extraSkills) {
  const root = createFixtureRoot(extraSkills);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LINK_RE = /\]\(([^)\s]+)\)/g;
function relativeLinks(text) {
  return [...text.matchAll(LINK_RE)].map((m) => m[1]).filter((t) => !/^(https?:|#)/.test(t));
}

test('members land only in skill-packs, the entry and plain skills stay in skills', () => {
  withFixture((root) => {
    runOk(root, ['sync']);
    for (const base of ['.claude', '.agents']) {
      assert.ok(existsSync(join(root, base, 'skill-packs/demo-a/SKILL.md')));
      assert.ok(existsSync(join(root, base, 'skill-packs/demo-a/references/x.md')));
      assert.ok(existsSync(join(root, base, 'skill-packs/demo-b/SKILL.md')));
      assert.ok(!existsSync(join(root, base, 'skills/demo-a')));
      assert.ok(!existsSync(join(root, base, 'skills/demo-b')));
      assert.ok(existsSync(join(root, base, 'skills/demo/SKILL.md')));
      assert.ok(existsSync(join(root, base, 'skills/plain/SKILL.md')));
    }
  });
});

test('entry gets a generated index with working links, members get a footer', () => {
  withFixture((root) => {
    runOk(root, ['sync']);
    for (const base of ['.claude', '.agents']) {
      const entryPath = join(root, base, 'skills/demo/SKILL.md');
      const entry = readFileSync(entryPath, 'utf8');
      assert.match(entry, /<!-- BEGIN: generated skill-pack index -->/);
      assert.match(entry, /## 本包子 skill（按需读取）/);
      assert.match(entry, /\| skill \| 用途 \| 路径 \|/);
      assert.match(entry, /\| `demo-a` \| Alpha member，做 A 事 \|/);
      assert.match(entry, /\| `demo-b` \| Bravo member \\\| pipe \|/);
      assert.ok(entry.indexOf('`demo-a`') < entry.indexOf('`demo-b`'));
      for (const link of relativeLinks(entry)) {
        assert.ok(existsSync(join(dirname(entryPath), link)), `dangling ${link} in ${base} entry`);
      }
      const memberPath = join(root, base, 'skill-packs/demo-a/SKILL.md');
      const member = readFileSync(memberPath, 'utf8');
      assert.match(member, /<!-- BEGIN: generated skill-pack footer -->/);
      assert.match(member, /本 skill 属于 `demo` 包，不在 Skill 工具清单里/);
      assert.ok(existsSync(join(dirname(memberPath), '../../skills/demo/SKILL.md')));
      assert.ok(
        !readFileSync(join(root, base, 'skills/plain/SKILL.md'), 'utf8').includes(
          'generated skill-pack',
        ),
      );
    }
  });
});

test('cross-root links are recomputed, same-class links stay byte-identical', () => {
  withFixture((root) => {
    runOk(root, ['sync']);
    const member = readFileSync(join(root, '.claude/skill-packs/demo-a/SKILL.md'), 'utf8');
    assert.ok(member.includes('](../demo-b/SKILL.md)'), 'same-class sibling link changed');
    assert.ok(member.includes('](references/x.md)') && member.includes('](./references/y.md)'));
    assert.ok(member.includes('](../../skills/plain/SKILL.md)'), 'cross-root link not rewritten');
    assert.ok(member.includes('](../../../doc/x.md)'), 'out-of-skills link must stay');
    assert.ok(member.includes('(https://example.com/a)') && member.includes('(#top)'));
    assert.ok(member.includes('[fenced](../plain/SKILL.md)'), 'fenced code must not be rewritten');
    const y = readFileSync(join(root, '.claude/skill-packs/demo-a/references/y.md'), 'utf8');
    assert.ok(y.includes('](../../../skills/plain/SKILL.md#sec)'));
    assert.ok(y.includes('](../SKILL.md)'));
    const plain = readFileSync(join(root, '.claude/skills/plain/SKILL.md'), 'utf8');
    assert.ok(plain.includes('](../../skill-packs/demo-a/SKILL.md)'));
    assert.ok(plain.includes('](../demo/SKILL.md)'));
    const entry = readFileSync(join(root, '.claude/skills/demo/SKILL.md'), 'utf8');
    assert.ok(entry.includes('](../../skill-packs/demo-a/references/x.md)'));

    // Every rewritten non-fenced link resolves to a file from its mirror location.
    for (const base of ['.claude', '.agents']) {
      for (const [rel, text] of Object.entries(snapshot(join(root, base)))) {
        if (!rel.endsWith('.md') || rel.includes('/demo/') || rel.includes('/demo-a/SKILL.md'))
          continue;
        for (const link of relativeLinks(text.replace(/```[\s\S]*?```/g, '')).filter(
          (l) => !l.includes('doc/x.md'),
        )) {
          const target = join(root, base, dirname(rel), link.replace(/[#?].*$/, ''));
          assert.ok(existsSync(target), `${base}${rel}: dangling ${link}`);
        }
      }
    }
  });
});

test('check sees no drift right after sync (generation is deterministic)', () => {
  withFixture((root) => {
    runOk(root, ['sync']);
    const first = snapshot(join(root, '.claude'));
    runOk(root, ['sync']);
    assert.deepEqual(snapshot(join(root, '.claude')), first);
    const result = run(root, ['check']);
    assert.equal(result.status, 0, result.stderr);
  });
});

test('check reports drift when a pack mirror file is stale', () => {
  withFixture((root) => {
    runOk(root, ['sync']);
    writeFileSync(join(root, '.claude/skill-packs/demo-b/SKILL.md'), 'tampered\n');
    const result = run(root, ['check']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed: \.claude\/skill-packs\/demo-b\/SKILL\.md/);
  });
});

test('an unregistered prefix-sibling source skill fails check naming it', () => {
  withFixture(
    (root) => {
      const result = run(root, ['check']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /skill-pack-registry:.*demo-foo/);
      assert.match(result.stderr, /not registered/);
    },
    { 'demo-foo/SKILL.md': '---\nname: demo-foo\ndescription: x\n---\n' },
  );
});

test('sync removes stray flat copies of members and stale pack files', () => {
  withFixture((root) => {
    runOk(root, ['sync']);
    mkdirSync(join(root, '.claude/skills/demo-a'), { recursive: true });
    writeFileSync(join(root, '.claude/skills/demo-a/SKILL.md'), 'stray flat copy\n');
    writeFileSync(join(root, '.agents/skill-packs/demo-a/stale.md'), 'stale\n');
    const drift = run(root, ['check']);
    assert.match(drift.stderr, /extra: \.claude\/skills\/demo-a\/SKILL\.md/);
    assert.match(drift.stderr, /extra: \.agents\/skill-packs\/demo-a\/stale\.md/);
    runOk(root, ['sync']);
    assert.ok(!existsSync(join(root, '.claude/skills/demo-a')));
    assert.ok(!existsSync(join(root, '.agents/skill-packs/demo-a/stale.md')));
  });
});

test('vendoring an unchanged pack member is a no-op on the source', () => {
  withFixture((root) => {
    runOk(root, ['sync']);
    const before = snapshot(join(root, '.vibe-coding/skills'));
    runOk(root, ['vendor', 'demo-a', '--from', 'claude']);
    assert.deepEqual(snapshot(join(root, '.vibe-coding/skills')), before);
    runOk(root, ['vendor', 'demo-a', '--from', 'agents']);
    assert.deepEqual(snapshot(join(root, '.vibe-coding/skills')), before);
    runOk(root, ['vendor', 'demo', '--from', 'claude']);
    assert.deepEqual(snapshot(join(root, '.vibe-coding/skills')), before);
  });
});

test('vendor prefers a fresh flat third-party install and sync moves it into skill-packs', () => {
  withFixture((root) => {
    runOk(root, ['sync']);
    mkdirSync(join(root, '.claude/skills/demo-b'), { recursive: true });
    writeFileSync(
      join(root, '.claude/skills/demo-b/SKILL.md'),
      '---\nname: demo-b\ndescription: upgraded\n---\n\n# demo-b v2\n',
    );
    runOk(root, ['vendor', 'demo-b', '--from', 'claude']);
    assert.match(
      readFileSync(join(root, '.vibe-coding/skills/demo-b/SKILL.md'), 'utf8'),
      /demo-b v2/,
    );
    assert.ok(!existsSync(join(root, '.claude/skills/demo-b')));
    assert.match(
      readFileSync(join(root, '.claude/skill-packs/demo-b/SKILL.md'), 'utf8'),
      /demo-b v2/,
    );
  });
});

test('--skill-packs-config is refused without --root', () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, 'check', '--skill-packs-config', '/nonexistent.json'],
    { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /only allowed together with --root/);
});

test('the shipped registry is empty, so a fresh project behaves exactly as before', () => {
  assert.deepEqual([...SKILL_PACKS], []);
  assert.equal(packOf('anything'), null);
});

test('link rewrite helpers are exact inverses and parseSkillDescription handles scalar styles', () => {
  const text = 'a [x](../demo-a/SKILL.md#h) b [y](./r.md)\n```\n[z](../demo-a/SKILL.md)\n```\n';
  // rewriteLinksToMirror needs an active registry: install the fixture pack for this test only.
  overrideSkillPacks([{ id: 'demo', entry: 'demo', members: ['demo-a'], memberPrefix: 'demo-' }]);
  try {
    const forward = rewriteLinksToMirror(text, 'plain-skill', 'SKILL.md');
    assert.ok(forward.includes('](../../skill-packs/demo-a/SKILL.md#h)'));
    assert.ok(forward.includes('[z](../demo-a/SKILL.md)'));
    assert.equal(rewriteLinksFromMirror(forward, 'plain-skill', 'SKILL.md', 'skills'), text);
  } finally {
    overrideSkillPacks([]);
  }

  assert.equal(parseSkillDescription('---\ndescription: plain text\n---\n'), 'plain text');
  assert.equal(parseSkillDescription("---\ndescription: 'it''s'\n---\n"), "it's");
  assert.equal(parseSkillDescription('---\ndescription: "q \\"x\\""\n---\n'), 'q "x"');
  assert.equal(parseSkillDescription('---\ndescription: |\n  l1\n  l2\nname: n\n---\n'), 'l1\nl2');
  assert.equal(parseSkillDescription('---\nname: n\n---\n'), '');
});

test('splitSkillRel uses native separators and normalizes inner paths for either platform', () => {
  const skillsRoot = 'C:\\repo\\.vibe-coding\\skills';
  const windowsRelative = win32.relative(
    skillsRoot,
    win32.join(skillsRoot, 'demo', 'references', 'deep', 'SKILL.md'),
  );
  const expected = { name: 'demo', inner: 'references/deep/SKILL.md' };
  assert.equal(windowsRelative, 'demo\\references\\deep\\SKILL.md');
  for (const separator of ['/', win32.sep]) {
    assert.deepEqual(splitSkillRel('demo/references/deep/SKILL.md', separator), expected);
    assert.deepEqual(splitSkillRel(windowsRelative, separator), expected);
  }
});

test('validateSkillPacks covers missing member/entry, entry-as-member and double membership', () => {
  const packs = [
    { id: 'p', entry: 'e', members: ['m1', 'e', 'm2'], memberPrefix: 'm' },
    { id: 'q', entry: 'e2', members: ['m1'], memberPrefix: null },
  ];
  const errors = validateSkillPacks(['m1', 'e', 'm-new'], packs).join('\n');
  assert.match(errors, /member 'm2' is missing/);
  assert.match(errors, /entry skill 'e2' is missing/);
  assert.match(errors, /entry 'e' must not also be listed as a member/);
  assert.match(errors, /'m1' is a member of two packs/);
  assert.match(errors, /'m-new' looks like a 'p' pack member/);
  assert.deepEqual(
    validateSkillPacks(['e', 'm'], [{ id: 'p', entry: 'e', members: ['m'], memberPrefix: 'm' }]),
    [],
  );
});
