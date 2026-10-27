import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBackendArchitecture } from '../../src/backend/index.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'backend-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); };
  const config = { schemaVersion: 1, services: [{ root: 'app/service', module: 'app.service' }], scanRoots: ['app'], ormModules: ['app.database'], providerModules: ['vendor'], providerRoots: ['app/provider'] };
  put('app/provider/client.py', 'import vendor\n');
  put('app/service/one/query.py', 'from sqlalchemy import select as fetch\ndef find(session):\n    return session.execute(fetch(1))\n');
  put('app/service/two/facade.py', 'def get() -> str:\n    return "ok"\n');
  const save = () => put('config.json', JSON.stringify(config));
  save();
  return { root, put, config, save, run: () => checkBackendArchitecture({ projectRoot: root, configPath: 'config.json' }) };
}

test('consumer: valid files pass, including relative facade imports', t => {
  const f = fixture(t);
  f.put('app/service/one/service.py', 'from ..two import facade\nfrom ..two.facade import get\n');
  const result = f.run();
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.engine, 'python'); assert.equal(result.rulesVersion, 1); assert.equal(result.filesScanned, 4);
});

test('detect slot, read-only, cross-domain, ORM annotation and provider violations', t => {
  const f = fixture(t);
  f.put('app/service/one/service.py', 'from sqlalchemy import select as fetch\nfrom ..two import query\nimport vendor.client\ndef run(session):\n    return session.execute(fetch(1))\n');
  f.put('app/service/one/query.py', 'from sqlalchemy import update as change, text\ndef run(session):\n    session.execute(change(1))\n    session.execute(text("DELETE FROM stuff"))\n    session.commit()\n');
  f.put('app/service/one/assembler.py', 'def assemble(session):\n    return session.execute("SELECT 1")\n');
  f.put('app/service/two/facade.py', 'from app.database import Entity as Row\ndef no_return():\n    pass\ndef get() -> "list[Row]":\n    pass\n');
  const result = f.run();
  const rules = new Set(result.findings.map(x => x.rule));
  for (const rule of ['sql-slot', 'readonly-write', 'cross-domain-import', 'facade-return', 'facade-orm-return', 'provider-import']) assert.ok(rules.has(rule), rule);
  assert.ok(result.findings.some(x => x.rule === 'sql-slot' && x.path.endsWith('assembler.py')));
  assert.ok(result.findings.filter(x => x.rule === 'readonly-write').length >= 3);
  assert.ok(result.findings.every(x => Number.isInteger(x.line) && x.line > 0 && x.path && x.message));
});

test('cycles include relative module imports and tests are scanned', t => {
  const f = fixture(t);
  f.put('app/service/one/a.py', 'from . import b\n');
  f.put('app/service/one/b.py', 'from . import a\n');
  f.put('app/service/one/test_query.py', 'def test_it(session):\n    session.execute("select 1")\n');
  const result = f.run();
  assert.equal(result.findings.filter(x => x.rule === 'import-cycle').length, 2);
  assert.ok(result.findings.some(x => x.rule === 'sql-slot' && x.path.endsWith('test_query.py')));
});

test('syntax, configuration and empty or missing scopes fail closed', t => {
  const f = fixture(t);
  f.put('app/service/one/bad.py', 'def bad(:\n'); assert.throws(f.run, /SyntaxError/);
  f.put('app/service/one/bad.py', 'pass\n');
  f.config.language = 'go'; f.save(); assert.throws(f.run, /only language python/);
  delete f.config.language; f.config.extra = true; f.save(); assert.throws(f.run, /unknown/);
  delete f.config.extra; f.config.services[0].root = 'missing'; f.save(); assert.throws(f.run);
  f.put('empty/placeholder.txt', ''); f.config.services[0].root = 'empty'; f.save(); assert.throws(f.run, /empty service/);
});

test('analyzer can be copied outside kit and executed from a consumer', async t => {
  const f = fixture(t);
  const installed = path.join(f.root, 'installed');
  cpSync(new URL('../../src/backend/', import.meta.url), installed, { recursive: true });
  const api = await import(pathToFileURL(path.join(installed, 'index.mjs')).href);
  assert.equal(api.checkBackendArchitecture({ projectRoot: f.root, configPath: 'config.json' }).ok, true);
});

test('cross-service ownership protects internals and permits facade imports', t => {
  const f = fixture(t);
  f.put('other/service/catalog/facade.py', 'def get() -> str:\n    return "ok"\n');
  f.put('other/service/catalog/query.py', 'pass\n');
  f.config.services.push({ root: 'other/service', module: 'other.service' });
  f.save();
  f.put('app/service/one/service.py', 'from other.service.catalog.facade import get\n');
  assert.equal(f.run().ok, true);
  f.put('app/service/one/service.py', 'from other.service.catalog.query import find\n');
  assert.ok(f.run().findings.some(x => x.rule === 'cross-domain-import' && x.message.includes('other.service.catalog.query')));
});

test('detect database calls through self attributes and simple aliases', t => {
  const f = fixture(t);
  f.put('app/service/one/assembler.py', 'def assemble(self):\n    connection_alias = self.session\n    self.session.execute("select 1")\n    connection_alias.execute("select 2")\n');
  const findings = f.run().findings.filter(x => x.rule === 'sql-slot');
  assert.deepEqual(findings.map(x => x.line), [3, 4]);
});

test('type-checking imports still enforce boundaries but do not form runtime cycles', t => {
  const f = fixture(t);
  f.put('app/service/one/a.py', 'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from . import b\n');
  f.put('app/service/one/b.py', 'import typing as types\nif types.TYPE_CHECKING:\n    from . import a\n');
  assert.equal(f.run().findings.filter(x => x.rule === 'import-cycle').length, 0);
  f.put('app/service/one/a.py', 'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from ..two import query\n    import vendor\n');
  const rules = new Set(f.run().findings.map(x => x.rule));
  assert.ok(rules.has('cross-domain-import'));
  assert.ok(rules.has('provider-import'));
});

test('cross-service imports require the public module immediately after its domain', t => {
  const f = fixture(t);
  f.config.services.push({ root: 'other/service', module: 'other.service' });
  f.put('other/service/catalog/facade.py', 'def get() -> str:\n    return "ok"\n');
  f.put('other/service/catalog/internal/facade/secret.py', 'pass\n');
  f.put('other/service/catalog/facade/private/secret.py', 'pass\n');
  f.save();
  const denied = [
    'import other.service',
    'from other import service',
    'import other.service.catalog',
    'import other.service.catalog.internal.facade.secret',
    'import other.service.catalog.facade.private.secret',
    'from other.service.catalog.facade.private import secret',
    'from other.service.catalog.facade import private',
  ];
  for (const statement of denied) {
    f.put('app/service/one/service.py', statement + '\n');
    assert.ok(f.run().findings.some(x => x.rule === 'cross-domain-import'), statement);
  }
  for (const statement of ['from other.service.catalog.facade import get', 'from other.service.catalog import facade', 'import app.service', 'from app.service import one']) {
    f.put('app/service/one/service.py', statement + '\n');
    assert.equal(f.run().findings.filter(x => x.rule === 'cross-domain-import').length, 0, statement);
  }
});
