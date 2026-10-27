import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkTypeScriptArchitecture } from '../../src/backend/typescript.mjs';

function fixture(t, files, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-ts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  const config = { schemaVersion: 1, language: 'typescript', services: [{ root: 'src/domains', module: '@domains' }], ormModules: ['typeorm'], providerModules: ['stripe'], ...overrides };
  const configPath = path.join(root, 'config.json'); fs.writeFileSync(configPath, JSON.stringify(config));
  return () => checkTypeScriptArchitecture({ projectRoot: root, configPath });
}

test('accepts facade boundaries and read/write slots with explicit returns', t => {
  const check = fixture(t, {
    'src/domains/a/service.ts': "import { api } from '@domains/b/facade'; api();",
    'src/domains/a/query.ts': 'db.find();',
    'src/domains/a/operate.ts': 'session.save({});',
    'src/domains/b/facade.ts': 'export function api(): string { return "ok"; }',
    'src/domains/b/model.ts': 'export type Data = string;'
  });
  assert.deepEqual(check(), { ok: true, engine: 'typescript', rulesVersion: 1, filesScanned: 5, findings: [] });
});

test('detects boundaries, imported aliases, read-only writes and facade annotations', t => {
  const check = fixture(t, {
    'src/domains/a/service.ts': "import { x } from '../b/query'; import Stripe from 'stripe'; db.query('select 1');",
    'src/domains/a/assembler.ts': "import { select as choose } from 'typeorm'; choose();",
    'src/domains/a/query.ts': "connection.query('DELETE FROM users'); session.save({});",
    'src/domains/a/facade.ts': "import { Entity as Row } from 'typeorm'; export function f(): Row { throw 0; } export const g = () => 1; export class C { method() { return 1; } }",
    'src/domains/b/query.ts': 'export const x = 1;'
  });
  const result = check();
  const counts = rule => result.findings.filter(f => f.rule === rule).length;
  assert.equal(result.ok, false);
  assert.equal(counts('cross-domain-import'), 1);
  assert.equal(counts('provider-import'), 1);
  assert.equal(counts('sql-slot'), 2);
  assert.equal(counts('readonly-write'), 2);
  assert.equal(counts('facade-return'), 2);
  assert.equal(counts('facade-orm-return'), 1);
  assert(result.findings.every(f => f.path.startsWith('src/') && f.line >= 1));
});

test('allows configured provider roots and checks aliased imports, reexports and cycles', t => {
  const check = fixture(t, {
    'src/domains/providers/facade.ts': "import Stripe from 'stripe'; export function ok(): void {}",
    'src/domains/a/service.ts': "export { x } from '@domains/b/query';",
    'src/domains/b/query.ts': "import { y } from '../a/service'; export const x = 1;"
  }, { providerRoots: ['src/domains/providers'] });
  const findings = check().findings;
  assert.equal(findings.filter(f => f.rule === 'provider-import').length, 0);
  assert.equal(findings.filter(f => f.rule === 'import-cycle').length, 2);
  assert.equal(findings.filter(f => f.rule === 'cross-domain-import').length, 2);
});

test('fails closed on syntax errors, empty scopes, unknown fields and unsupported versions', t => {
  assert.throws(fixture(t, { 'src/domains/a/service.ts': 'export function {' }), /syntax error/i);
  assert.throws(fixture(t, { 'src/domains/a/file.txt': 'text' }), /empty service scope/);
  assert.throws(fixture(t, { 'src/domains/a/service.ts': '' }, { unexpected: true }), /unknown/);
  assert.throws(fixture(t, { 'src/domains/a/service.ts': '' }, { schemaVersion: 2 }), /unsupported/);
});

test('scans every TypeScript file under configured roots, including hidden and nested directories', t => {
  const check = fixture(t, { 'src/domains/a/.hidden/deep/service.tsx': 'db.query("select 1")', 'other/not-scanned.ts': 'db.save({})' });
  const result = check();
  assert.equal(result.filesScanned, 1);
  assert.equal(result.findings[0].rule, 'sql-slot');
});

test('scans explicit extra roots for provider imports', t => {
  const check = fixture(t, {
    'src/domains/a/service.ts': '',
    'src/extra/tool.ts': "import Stripe from 'stripe';"
  }, { scanRoots: ['src/extra'] });
  assert.equal(check().filesScanned, 2);
  assert.equal(check().findings[0].rule, 'provider-import');
});

test('checks private imports across service roots and this database receiver', t => {
  const check = fixture(t, {
    'src/domains/a/service.ts': "import { x } from '@other/b/query'; this.db.query('select 1');",
    'src/other/b/query.ts': 'export const x = 1;'
  }, { services: [{ root: 'src/domains', module: '@domains' }, { root: 'src/other', module: '@other' }] });
  const findings = check().findings;
  assert.equal(findings.filter(f => f.rule === 'cross-domain-import').length, 1);
  assert.equal(findings.filter(f => f.rule === 'sql-slot').length, 1);
});

test('resolves default and explicit relative config paths from project root', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-ts-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/domains/a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/domains/a/service.ts'), '');
  fs.mkdirSync(path.join(root, '.vibe-coding'));
  const config = JSON.stringify({ schemaVersion: 1, language: 'typescript', services: [{ root: 'src/domains', module: '@domains' }] });
  fs.writeFileSync(path.join(root, '.vibe-coding/backend-architecture.json'), config);
  fs.writeFileSync(path.join(root, 'custom.json'), config);
  assert.equal(checkTypeScriptArchitecture({ projectRoot: root }).ok, true);
  assert.equal(checkTypeScriptArchitecture({ projectRoot: root, configPath: 'custom.json' }).ok, true);
});

test('type-only import and export cycles are not runtime cycles but retain boundary checks', t => {
  const check = fixture(t, {
    'src/domains/a/service.ts': "import type { B } from '../b/query'; export type { C } from '../c/query'; export type A = B & C;",
    'src/domains/b/query.ts': "import { type A } from '../a/service'; export type B = A;",
    'src/domains/c/query.ts': "export { type A } from '../a/service'; export type C = string;"
  });
  const findings = check().findings;
  assert.equal(findings.filter(f => f.rule === 'import-cycle').length, 0);
  assert.equal(findings.filter(f => f.rule === 'cross-domain-import').length, 4);
});

test('resolves JavaScript import specifiers to TSX for cycle detection', t => {
  const check = fixture(t, {
    'src/domains/a/a.ts': "import './b.js';",
    'src/domains/a/b.tsx': "import './a.js';"
  });
  assert.equal(check().findings.filter(f => f.rule === 'import-cycle').length, 2);
});

test('requires an explicit public entry when importing another service root', t => {
  const check = fixture(t, {
    'src/domains/a/service.ts': "import '@other'; import '@other/b/facade';",
    'src/other/index.ts': "export * from './b/query';",
    'src/other/b/query.ts': 'export const value = 1;',
    'src/other/b/facade.ts': 'export function read(): number { return 1; }'
  }, { services: [{ root: 'src/domains', module: '@domains' }, { root: 'src/other', module: '@other' }] });
  const violations = check().findings.filter(f => f.rule === 'cross-domain-import');
  assert.equal(violations.length, 2);
  assert(violations.some(f => f.path === 'src/domains/a/service.ts' && f.message.includes('@other')));
  assert(violations.some(f => f.path === 'src/other/index.ts'));
});

test('enforces ownership for root and domain importers across entry forms', t => {
  const cases = [
    ['src/domains/a/service.ts', '@domains/a/private', false],
    ['src/domains/a/service.ts', '../b/facade', false],
    ['src/domains/a/service.ts', '../b/facade/index', false],
    ['src/domains/a/service.ts', '../b/facade/private', true],
    ['src/domains/a/service.ts', '../b/query', true],
    ['src/domains/root.ts', '@domains/b/query', true],
    ['src/domains/root.ts', '@domains/b/facade', false],
    ['src/domains/root.ts', '@domains', false],
    ['src/domains/root.ts', '@other', true],
    ['src/domains/root.ts', '@other/b/query', true],
    ['src/domains/root.ts', '@other/b/facade', false],
    ['src/domains/a/service.ts', '@other/b/contracts/index', false],
    ['src/domains/a/service.ts', '@other/b/contracts/private', true]
  ];
  for (const [source, target, violation] of cases) {
    for (const form of ['import', 'type', 'export']) {
      const text = form === 'import' ? `import '${target}';` : form === 'type' ? `import type { X } from '${target}';` : `export { X } from '${target}';`;
      const check = fixture(t, {
        [source]: text,
        'src/domains/b/facade.ts': 'export const X = 1;',
        'src/other/b/facade.ts': 'export const X = 1;'
      }, { services: [{ root: 'src/domains', module: '@domains' }, { root: 'src/other', module: '@other' }] });
      assert.equal(check().findings.some(f => f.rule === 'cross-domain-import'), violation, `${source} ${form} ${target}`);
    }
  }
});
