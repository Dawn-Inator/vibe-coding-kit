// Execute only the build-frame font sections. The full CLI captures network/assets and is deliberately
// not evaluated: these blocks receive temp filesystem ports and have no process/module access.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import vm from 'node:vm';

const ts = createRequire(import.meta.url)('typescript');

function parse(source) {
  const file = ts.createSourceFile('build-frame.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(file.parseDiagnostics.length, 0, 'build-frame must parse');
  return file;
}

function hasDeclaration(node, name) {
  let found = false;
  const visit = (child) => {
    if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.name.text === name) found = true;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

export function fontStagingProgram(source, { forceNormal = false, pretty = false } = {}) {
  const file = parse(source);
  const blocks = file.statements.filter((node) => ts.isIfStatement(node) && hasDeclaration(node, 'weightInfo'));
  assert.equal(blocks.length, 1, 'exactly one font staging block');
  if (!forceNormal && !pretty) return blocks[0].getText(file);
  const transformed = ts.transform(blocks[0], [(context) => {
    const visit = (node) => {
      if (forceNormal && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'styleOf') {
        return context.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type,
          context.factory.createArrowFunction(undefined, undefined, [], undefined,
            context.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), context.factory.createStringLiteral('normal')));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (node) => ts.visitNode(node, visit);
  }]);
  try {
    return ts.createPrinter().printNode(ts.EmitHint.Unspecified, transformed.transformed[0], file);
  } finally {
    transformed.dispose();
  }
}

export function executeFontStaging(program, project, family) {
  const checked = (path) => {
    const resolved = resolve(path);
    const base = resolve(project);
    assert.ok(resolved === base || resolved.startsWith(base + sep), 'font fixture filesystem access must stay inside its temp project');
    return resolved;
  };
  const context = {
    brandFonts: [family], hyperframesDir: project, md: '', summary: [], join,
    existsSync: (path) => fs.existsSync(checked(path)),
    readdirSync: (path) => fs.readdirSync(checked(path)),
    mkdirSync: (path, options) => fs.mkdirSync(checked(path), options),
    copyFileSync: (from, to) => fs.copyFileSync(checked(from), checked(to)),
    // Captured-face metadata is absent in this fixture, exercising the legacy filename path.
    stageCapturedFonts: () => ({ faces: [], files: [], families: new Set() }),
  };
  vm.runInNewContext(program, context, { timeout: 1000 });
  return context.md;
}

export function iconClassifier(source) {
  const file = parse(source);
  const statements = file.statements.filter((node) => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) &&
      ['ICON_FONT_PATTERN', 'isIconFont'].includes(declaration.name.text)));
  assert.equal(statements.length, 2, 'icon classifier and its pattern must both exist');
  const program = statements.map((node) => node.getText(file)).join('\n');
  return (name) => vm.runInNewContext(`${program}\nisIconFont(name)`, { name }, { timeout: 1000 });
}
