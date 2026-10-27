import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkGoArchitecture } from '../../src/backend/go.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'go-architecture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, data) => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data); };
  const config = { schemaVersion: 1, language: 'go', services: [{ root: 'internal/domains', module: 'example.com/app/internal/domains' }], providerModules: ['vendor.example/sdk'], providerRoots: ['internal/provider'], ormModules: ['example.com/orm'] };
  put('internal/provider/client.go', 'package provider\nimport _ "vendor.example/sdk"\n');
  put('internal/domains/orders/query.go', 'package orders\nfunc Read(db DB) { db.Query("SELECT 1") }\n');
  put('internal/domains/users/facade.go', 'package users\nfunc Get() string { return "ok" }\n');
  const save = () => put('config.json', JSON.stringify(config)); save();
  return { root, put, config, save, run: () => checkGoArchitecture({ projectRoot: root, configPath: 'config.json' }) };
}

test('valid package APIs and query calls pass', t => {
  const f = fixture(t);
  f.put('internal/domains/orders/service.go', 'package orders\nimport "example.com/app/internal/domains/users"\nvar _ = users.Get\n');
  const result = f.run();
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.engine, 'go'); assert.equal(result.rulesVersion, 1); assert.equal(result.filesScanned, 4);
});

test('detect DB slot, readonly writes, ORM return and provider imports, including test files', t => {
  const f = fixture(t);
  f.put('internal/domains/orders/service_test.go', 'package orders\nimport _ "vendor.example/sdk"\nfunc test(s Service) { s.db.Query("select 1") }\n');
  f.put('internal/domains/orders/query.go', 'package orders\nfunc Write(db DB) { db.Exec("DELETE FROM x"); db.Query("UPDATE x SET y=1") }\n');
  f.put('internal/domains/users/facade.go', 'package users\nimport orm "example.com/orm"\nfunc NoResult() {}\nfunc Get() *orm.Entity { return nil }\n');
  const result = f.run(); const rules = new Set(result.findings.map(x => x.rule));
  for (const rule of ['sql-slot', 'readonly-write', 'facade-orm-return', 'provider-import']) assert.ok(rules.has(rule), rule);
  assert.equal(result.findings.filter(x => x.rule === 'readonly-write').length, 2);
  assert.ok(!result.findings.some(x => x.rule === 'facade-return'));
  assert.ok(result.findings.every(x => x.path && x.line > 0 && x.message));
});

test('package import cycles are reported and build tags do not hide files', t => {
  const f = fixture(t);
  f.put('internal/domains/orders/a.go', 'package orders\nimport _ "example.com/app/internal/domains/users"\n');
  f.put('internal/domains/users/a.go', '//go:build never\n\npackage users\nimport _ "example.com/app/internal/domains/orders"\n');
  assert.equal(f.run().findings.filter(x => x.rule === 'import-cycle').length, 2);
});

test('invalid syntax, configuration, empty scope and symlinks fail closed', t => {
  const f = fixture(t);
  f.put('internal/domains/orders/bad.go', 'package orders\nfunc broken(\n'); assert.throws(f.run, /analyzer failed/);
  f.put('internal/domains/orders/bad.go', 'package orders\n'); f.config.extra = true; f.save(); assert.throws(f.run, /unknown field/);
  delete f.config.extra; f.config.services[0].root = '../outside'; f.save(); assert.throws(f.run, /invalid relative path/);
  f.put('empty/placeholder', ''); f.config.services[0].root = 'empty'; f.save(); assert.throws(f.run, /empty service/);
  f.config.services[0].root = 'internal/domains'; f.save(); symlinkSync(os.tmpdir(), path.join(f.root, 'internal/domains/link'), process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(f.run, /symlink/);
});

 test('scanRoots cover provider imports outside domain rules', t => {
  const f = fixture(t);
  f.put('other/client.go', 'package other\nimport _ "vendor.example/sdk"\nfunc f(db DB) { db.Query("select 1") }\n');
  f.config.scanRoots = ['other']; f.save();
  const result = f.run();
  assert.ok(result.findings.some(x => x.rule === 'provider-import' && x.path === 'other/client.go'));
  assert.ok(!result.findings.some(x => x.rule === 'sql-slot' && x.path === 'other/client.go'));
 });

test('exported methods and functions outside facade reject ORM return types', t => {
  const f = fixture(t);
  f.put('internal/domains/orders/service.go', 'package orders\nimport orm "example.com/orm"\nfunc Command() {}\nfunc Load() *orm.Entity { return nil }\nfunc (x Store) Get() []orm.Entity { return nil }\nfunc private() *orm.Entity { return nil }\n');
  assert.equal(f.run().findings.filter(x => x.rule === 'facade-orm-return').length, 2);
});

test('cycles spanning multiple service roots are detected', t => {
  const f = fixture(t);
  f.config.services.push({ root: 'other/domains', module: 'example.com/other/domains' }); f.save();
  f.put('internal/domains/orders/a.go', 'package orders\nimport _ "example.com/other/domains/billing"\n');
  f.put('other/domains/billing/a.go', 'package billing\nimport _ "example.com/app/internal/domains/orders"\n');
  assert.equal(f.run().findings.filter(x => x.rule === 'import-cycle').length, 2);
});

test('service root package alone is scanned and cannot make database calls outside a slot', t => {
  const f = fixture(t);
  f.put('rootonly/service.go', 'package rootonly\nfunc Run(db DB) { db.Query("select 1") }\n');
  f.config.services = [{ root: 'rootonly', module: 'example.com/rootonly' }]; f.save();
  assert.ok(f.run().findings.some(x => x.rule === 'sql-slot' && x.path === 'rootonly/service.go'));
});

test('root package remains checked with child packages and participates in cycles', t => {
  const f = fixture(t);
  f.put('internal/domains/service.go', 'package domains\nimport _ "example.com/app/internal/domains/orders"\nfunc Run(db DB) { db.Query("select 1") }\n');
  f.put('internal/domains/orders/a.go', 'package orders\nimport _ "example.com/app/internal/domains"\n');
  const result = f.run();
  assert.ok(result.findings.some(x => x.rule === 'sql-slot' && x.path === 'internal/domains/service.go'));
  assert.equal(result.findings.filter(x => x.rule === 'import-cycle').length, 2);
});
