import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// TypeScript is a required consumer or kit development dependency; fail closed if absent.
function compiler(projectRoot) {
  try { return createRequire(path.join(projectRoot, 'package.json'))('typescript'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    try { return createRequire(import.meta.url)('typescript'); }
    catch (fallback) { throw new Error('TypeScript compiler dependency is required', { cause: fallback }); }
  }
}
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const moduleMatch = (name, prefix) => name === prefix || name.startsWith(prefix + '/');
const slots = new Set(['operate', 'query', 'projection']);
const writes = new Set(['save', 'insert', 'update', 'delete', 'remove', 'upsert', 'create', 'merge', 'commit', 'flush', 'executeUpdate', 'executeDelete']);
const operations = new Set([...writes, 'query', 'execute', 'select', 'find', 'findOne', 'findMany', 'get', 'getOne', 'getMany', 'createQueryBuilder', 'transaction']);
const receivers = new Set(['db', 'session', 'connection']);

export function checkTypeScriptArchitecture({ projectRoot, configPath = '.vibe-coding/backend-architecture.json' }) {
  const project = fs.realpathSync(projectRoot);
  const config = JSON.parse(fs.readFileSync(path.resolve(project, configPath), 'utf8'));
  const allowed = new Set(['schemaVersion', 'language', 'services', 'scanRoots', 'providerModules', 'providerRoots', 'ormModules']);
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => !allowed.has(k))) throw new Error('unknown or invalid config fields');
  if (config.schemaVersion !== 1 || config.language !== 'typescript') throw new Error('unsupported TypeScript architecture schema or language');
  const strings = (value, field) => {
    if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !x.trim())) throw new Error(`${field} must be an array of nonempty strings`);
    return value;
  };
  const directory = value => {
    if (typeof value !== 'string' || !value || path.isAbsolute(value)) throw new Error('roots must be nonempty project-relative paths');
    const result = fs.realpathSync(path.resolve(project, value));
    if (!inside(result, project) || !fs.statSync(result).isDirectory()) throw new Error(`invalid project directory: ${value}`);
    return result;
  };
  if (!Array.isArray(config.services) || !config.services.length) throw new Error('services must be a nonempty array');
  const services = config.services.map(s => {
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).sort().join(',') !== 'module,root' || typeof s.module !== 'string' || !s.module.trim() || s.module.startsWith('.') || s.module.endsWith('/')) throw new Error('each service requires root and module');
    return { root: directory(s.root), module: s.module };
  });
  for (let i = 0; i < services.length; i++) for (const b of services.slice(i + 1)) {
    const a = services[i];
    if (inside(a.root, b.root) || inside(b.root, a.root) || moduleMatch(a.module, b.module) || moduleMatch(b.module, a.module)) throw new Error('overlapping service scopes');
  }
  const scanRoots = strings(config.scanRoots ?? config.services.map(s => s.root), 'scanRoots').map(directory);
  if (!scanRoots.length) throw new Error('scanRoots must be nonempty');
  const providerRoots = strings(config.providerRoots ?? [], 'providerRoots').map(directory);
  const providers = strings(config.providerModules ?? [], 'providerModules');
  const orms = strings(config.ormModules ?? [], 'ormModules');
  const files = new Set();
  const walk = (dir, ancestry = new Set()) => {
    const real = fs.realpathSync(dir);
    if (!inside(real, project)) throw new Error(`path escapes project: ${dir}`);
    if (ancestry.has(real)) throw new Error(`directory cycle: ${dir}`);
    const next = new Set(ancestry).add(real);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) walk(file, next);
      else if (stat.isFile() && /\.tsx?$/.test(entry.name)) {
        const resolved = fs.realpathSync(file);
        if (!inside(resolved, project)) throw new Error(`file escapes project: ${file}`);
        files.add(resolved);
      }
    }
  };
  for (const root of new Set([...services.map(s => s.root), ...scanRoots])) {
    const before = files.size;
    walk(root);
    if (files.size === before && ![...files].some(f => inside(f, root))) throw new Error(`empty service scope: ${root}`);
  }
  const ts = compiler(project);
  if (typeof ts.createSourceFile !== "function" || !ts.ScriptTarget) throw new Error(`TypeScript compiler API required (installed version ${ts.version ?? "unknown"}); use TypeScript 5.9`);
  const sources = new Map();
  for (const file of [...files].sort()) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if (source.parseDiagnostics?.length) {
      const diagnostic = source.parseDiagnostics[0];
      throw new Error(`TypeScript syntax error ${path.relative(project, file)}:${source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    }
    sources.set(file, source);
  }
  const findings = [];
  const edges = new Map([...files].map(f => [f, new Set()]));
  const report = (rule, file, node, message) => findings.push({ rule, path: path.relative(project, file).split(path.sep).join('/'), line: sources.get(file).getLineAndCharacterOfPosition(node.getStart(sources.get(file))).line + 1, message });
  const resolveFile = base => {
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, base.replace(/\.(?:js|jsx|mjs|cjs)$/, '.ts'), base.replace(/\.(?:js|jsx)$/, '.tsx'), path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      const resolved = path.resolve(candidate);
      if (files.has(resolved)) return resolved;
    }
    return null;
  };
  for (const [file, source] of sources) {
    const service = services.find(s => inside(file, s.root));
    const parts = service ? path.relative(service.root, file).split(path.sep) : [];
    const domain = parts.length > 1 ? parts[0] : null;
    const slot = path.basename(file).replace(/\.tsx?$/, '');
    const aliases = new Map();
    const imports = [];
    const importTarget = (node, specifier, runtime = true) => {
      imports.push([node, specifier]);
      let base;
      if (specifier.startsWith('.')) base = path.resolve(path.dirname(file), specifier);
      else {
        const targetService = services.find(s => moduleMatch(specifier, s.module));
        if (targetService) base = path.join(targetService.root, specifier.slice(targetService.module.length).replace(/^\//, ''));
      }
      const target = base && resolveFile(base);
      if (target && runtime) edges.get(file).add(target);
      const targetService = base && services.find(s => inside(base, s.root));
      if (service && targetService) {
        const targetParts = path.relative(targetService.root, base).split(path.sep).filter(Boolean);
        const sameDomain = targetService === service && domain && targetParts[0] === domain;
        const sameRoot = targetService === service && targetParts.length === 0;
        const publicNames = new Set(['facade', 'model', 'models', 'contract', 'contracts']);
        const component = (targetParts[1] ?? '').replace(/\.(?:ts|tsx|js|jsx)$/, '');
        const publicEntry = publicNames.has(component) && (targetParts.length === 2 || (targetParts.length === 3 && /^index(?:\.(?:ts|tsx|js|jsx))?$/.test(targetParts[2])));
        if (!sameDomain && !sameRoot && !publicEntry) report('cross-domain-import', file, node, `Cross-domain import ${specifier} must use facade or model/contracts`);
      }
    };
    const registerBindings = (clause, spec) => {
      if (!clause) return;
      if (clause.name) aliases.set(clause.name.text, spec);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) aliases.set(bindings.name.text, spec);
      else if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) aliases.set(item.name.text, `${spec}/${(item.propertyName ?? item.name).text}`);
    };
    const nameOf = node => {
      if (ts.isIdentifier(node)) return node.text;
      if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
      if (ts.isPropertyAccessExpression(node)) return `${nameOf(node.expression)}.${node.name.text}`;
      if (ts.isCallExpression(node)) return nameOf(node.expression);
      return '';
    };
    const isExported = node => node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword);
    const inspectReturn = (node, label) => {
      if (!node.type) return report('facade-return', file, node, `Exported function ${label} needs a return annotation`);
      let orm = false;
      const visitType = n => {
        if (ts.isIdentifier(n)) {
          const origin = aliases.get(n.text);
          if (origin && orms.some(o => moduleMatch(origin, o))) orm = true;
        }
        if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal) && orms.some(o => moduleMatch(n.argument.literal.text, o))) orm = true;
        ts.forEachChild(n, visitType);
      };
      visitType(node.type);
      if (orm) report('facade-orm-return', file, node, `Exported function ${label} annotates a configured ORM type`);
    };
    // Collect import bindings before traversing uses, regardless of statement order.
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const clause = statement.importClause;
        const bindings = clause?.namedBindings;
        const onlyTypes = clause?.isTypeOnly || (clause && !clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly));
        importTarget(statement, statement.moduleSpecifier.text, !onlyTypes);
        registerBindings(statement.importClause, statement.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const bindings = statement.exportClause;
        const onlyTypes = statement.isTypeOnly || (bindings && ts.isNamedExports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly));
        importTarget(statement, statement.moduleSpecifier.text, !onlyTypes);
      }
      else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && statement.moduleReference.expression && ts.isStringLiteral(statement.moduleReference.expression)) {
        const spec = statement.moduleReference.expression.text; aliases.set(statement.name.text, spec); importTarget(statement, spec);
      }
    }
    const visit = node => {
      if (ts.isCallExpression(node)) {
        if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) importTarget(node, node.arguments[0].text);
        const name = nameOf(node.expression);
        const pieces = name.split('.');
        const origin = aliases.get(pieces[0]);
        const method = pieces.length === 1 && origin ? origin.split('/').at(-1) : pieces.at(-1);
        const orm = origin && orms.some(o => moduleMatch(origin, o));
        const database = service && operations.has(method) && (receivers.has(pieces[0]) || (['this', 'self'].includes(pieces[0]) && receivers.has(pieces[1])) || orm);
        if (database && !slots.has(slot)) report('sql-slot', file, node, `Database operation ${name} outside operate/query/projection`);
        let write = writes.has(method);
        if ((method === 'query' || method === 'execute') && node.arguments.length && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) write ||= /^(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(node.arguments[0].text.trim());
        if (database && write && (slot === 'query' || slot === 'projection')) report('readonly-write', file, node, `Write operation ${name} in read-only slot`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const [node, spec] of imports) if (providers.some(p => moduleMatch(spec, p)) && !providerRoots.some(root => inside(file, root))) report('provider-import', file, node, `Provider import ${spec} outside allowed roots`);
    if (slot === 'facade') for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && isExported(statement)) inspectReturn(statement, statement.name?.text ?? 'default');
      if (ts.isVariableStatement(statement) && isExported(statement)) for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) inspectReturn(declaration.initializer, declaration.name.getText(source));
      }
      if (ts.isClassDeclaration(statement) && isExported(statement)) for (const member of statement.members) {
        if (ts.isMethodDeclaration(member) && !member.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword) && !ts.isPrivateIdentifier(member.name)) inspectReturn(member, member.name.getText(source));
      }
    }
  }
  let index = 0;
  const indices = new Map(), low = new Map(), stack = [], active = new Set();
  function visit(file) {
    indices.set(file, index); low.set(file, index++); stack.push(file); active.add(file);
    for (const target of [...edges.get(file)].sort()) {
      if (!indices.has(target)) { visit(target); low.set(file, Math.min(low.get(file), low.get(target))); }
      else if (active.has(target)) low.set(file, Math.min(low.get(file), indices.get(target)));
    }
    if (low.get(file) === indices.get(file)) {
      const component = []; let item;
      do { item = stack.pop(); active.delete(item); component.push(item); } while (item !== file);
      if (component.length > 1 || edges.get(file).has(file)) {
        const paths = component.map(f => path.relative(project, f).split(path.sep).join('/')).sort();
        for (const member of component) report('import-cycle', member, sources.get(member), `Import cycle: ${paths.join(', ')}`);
      }
    }
  }
  for (const file of [...files].sort()) if (!indices.has(file)) visit(file);
  const unique = [...new Map(findings.map(f => [JSON.stringify(f), f])).values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule) || a.message.localeCompare(b.message));
  return { ok: unique.length === 0, engine: 'typescript', rulesVersion: 1, filesScanned: files.size, findings: unique };
}
