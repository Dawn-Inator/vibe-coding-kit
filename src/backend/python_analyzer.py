"""Portable, bounded static checks for configured Python service sources."""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

SLOTS = {"operate", "query", "projection", "assembler", "facade", "service"}
WRITE_CALLS = {"add", "add_all", "delete", "update", "insert", "merge", "commit", "flush", "bulk_save_objects", "bulk_insert_mappings", "bulk_update_mappings"}
SQL_CALLS = {"select", "insert", "update", "delete", "text", "execute", "executemany", "query", "scalar", "scalars", "get", "add", "add_all", "merge", "commit", "flush", "bulk_save_objects", "bulk_insert_mappings", "bulk_update_mappings"}
DB_RECEIVERS = {"db", "session", "database", "connection", "conn", "engine"}


def matches(value: str, prefix: str) -> bool:
    return value == prefix or value.startswith(prefix + ".")


def dotted(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted(node.value)
        return f"{parent}.{node.attr}" if parent else ""
    return ""


def strings(value: object, field: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise ValueError(f"{field} must be an array of nonempty strings")
    return value


def main() -> None:
    project = Path(sys.argv[1]).resolve(strict=True)
    config = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    if not isinstance(config, dict) or set(config) - {"schemaVersion", "language", "services", "scanRoots", "ormModules", "providerModules", "providerRoots"}:
        raise ValueError("unknown or invalid config fields")
    if config.get("schemaVersion") != 1 or isinstance(config.get("schemaVersion"), bool):
        raise ValueError("schemaVersion must be 1")
    if config.get("language", "python") != "python":
        raise ValueError("Python analyzer supports only language python")
    services = config.get("services")
    if not isinstance(services, list) or not services:
        raise ValueError("services must be a nonempty array")

    def directory(value: object) -> Path:
        if not isinstance(value, str) or not value or Path(value).is_absolute():
            raise ValueError("roots must be nonempty project-relative paths")
        result = (project / value).resolve(strict=True)
        if not result.is_relative_to(project) or not result.is_dir():
            raise ValueError(f"invalid project directory: {value}")
        return result

    parsed_services = []
    for service in services:
        if not isinstance(service, dict) or set(service) != {"root", "module"}:
            raise ValueError("each service requires only root and module")
        module = service["module"]
        if not isinstance(module, str) or not module or not all(part.isidentifier() for part in module.split(".")):
            raise ValueError("invalid service module")
        root = directory(service["root"])
        if not any(root.rglob("*.py")):
            raise ValueError(f"empty service scope: {root}")
        parsed_services.append((root, module))
    if len({root for root, _ in parsed_services}) != len(parsed_services) or len({module for _, module in parsed_services}) != len(parsed_services):
        raise ValueError("duplicate service root or module")
    for i, (root, module) in enumerate(parsed_services):
        for other, other_module in parsed_services[i + 1:]:
            if root.is_relative_to(other) or other.is_relative_to(root) or matches(module, other_module) or matches(other_module, module):
                raise ValueError("overlapping service scopes")
    scan_roots = [directory(value) for value in strings(config.get("scanRoots", [str(root.relative_to(project)) for root, _ in parsed_services]), "scanRoots")]
    if not scan_roots:
        raise ValueError("scanRoots must be nonempty")
    provider_roots = [directory(value) for value in strings(config.get("providerRoots", []), "providerRoots")]
    provider_modules = strings(config.get("providerModules", []), "providerModules")
    orm_modules = strings(config.get("ormModules", []), "ormModules")
    files: set[Path] = set()
    for root in scan_roots + [root for root, _ in parsed_services]:
        found = list(root.rglob("*.py"))
        if not found:
            raise ValueError(f"empty scan scope: {root}")
        for file in found:
            resolved = file.resolve(strict=True)
            if not resolved.is_relative_to(project):
                raise ValueError(f"file escapes project: {file}")
            files.add(resolved)
    trees = {file: ast.parse(file.read_text(encoding="utf-8"), filename=str(file)) for file in sorted(files)}
    module_by_file: dict[Path, str] = {}
    for file in files:
        for root, module in parsed_services:
            if file.is_relative_to(root):
                parts = list(file.relative_to(root).with_suffix("").parts)
                if parts[-1] == "__init__":
                    parts.pop()
                module_by_file[file] = ".".join([module, *parts])
    file_by_module = {module: file for file, module in module_by_file.items()}
    if len(file_by_module) != len(module_by_file):
        raise ValueError("duplicate Python module identities")
    findings: list[dict[str, object]] = []
    edges: dict[str, set[str]] = {module: set() for module in file_by_module}

    def report(rule: str, file: Path, node: ast.AST, message: str) -> None:
        findings.append({"rule": rule, "path": file.relative_to(project).as_posix(), "line": getattr(node, "lineno", 1), "message": message})

    for file, tree in trees.items():
        current = module_by_file.get(file)
        service = next(((root, module) for root, module in parsed_services if file.is_relative_to(root)), None)
        relative = file.relative_to(service[0]).parts if service else ()
        domain = relative[0] if len(relative) > 1 else None
        slot = file.stem if file.stem in SLOTS else None
        aliases: dict[str, str] = {}
        imports: list[tuple[ast.AST, str]] = []
        typing_names = {"typing"}
        checking_names = {"TYPE_CHECKING"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                typing_names.update(item.asname or item.name for item in node.names if item.name == "typing")
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module == "typing":
                checking_names.update(item.asname or item.name for item in node.names if item.name == "TYPE_CHECKING")
        type_only_nodes: set[ast.AST] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.If):
                condition = dotted(node.test)
                if condition in checking_names or any(condition == f"{name}.TYPE_CHECKING" for name in typing_names):
                    for statement in node.body:
                        type_only_nodes.update(ast.walk(statement))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for item in node.names:
                    aliases[item.asname or item.name.split(".")[0]] = item.name if item.asname else item.name.split(".")[0]
                    imports.append((node, item.name))
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    if not current:
                        continue
                    package = current if file.name == "__init__.py" else current.rpartition(".")[0]
                    components = package.split(".")
                    if node.level > len(components):
                        raise ValueError(f"invalid relative import: {file}:{node.lineno}")
                    base = ".".join(components[:len(components) - node.level + 1] + ([base] if base else []))
                if current and node not in type_only_nodes and base in edges and base != current:
                    edges[current].add(base)
                for item in node.names:
                    if item.name == "*":
                        imports.append((node, base))
                    else:
                        full = f"{base}.{item.name}" if base else item.name
                        aliases[item.asname or item.name] = full
                        imports.append((node, full))
        for node, target in imports:
            if any(matches(target, prefix) for prefix in provider_modules) and not any(file.is_relative_to(root) for root in provider_roots):
                report("provider-import", file, node, f"Provider import {target} outside allowed roots")
            if current and node not in type_only_nodes and target in edges and target != current:
                edges[current].add(target)
            target_service = next(((root, module) for root, module in parsed_services if matches(target, module)), None)
            if service and target_service:
                suffix = target[len(target_service[1]):].lstrip(".")
                parts = suffix.split(".") if suffix else []
                target_domain = parts[0] if parts else None
                different_owner = target_service[0] != service[0] or (target_domain is not None and domain is not None and target_domain != domain)
                public_names = {"facade", "model", "models", "contract", "contracts"}
                # A public module must directly follow the domain. A single imported
                # symbol is allowed, but an actual nested module is never a symbol.
                public_module = len(parts) == 2 and parts[1] in public_names
                public_symbol = (len(parts) == 3 and parts[1] in public_names
                                 and isinstance(node, ast.ImportFrom)
                                 and not any(matches(module, target) for module in file_by_module))
                if different_owner and not (public_module or public_symbol):
                    report("cross-domain-import", file, node, f"Cross-domain import {target} must use facade or model/contracts")
        def resolve(name: str) -> str:
            first, sep, rest = name.partition(".")
            return aliases.get(first, first) + (sep + rest if sep else "")
        database_aliases = set(DB_RECEIVERS)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
                value = dotted(node.value)
                if value and any(part in database_aliases for part in value.split(".")):
                    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                    database_aliases.update(target.id for target in targets if isinstance(target, ast.Name))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and service:
                name = dotted(node.func)
                full = resolve(name)
                method = full.rpartition(".")[2]
                receiver_parts = name.split(".")[:-1]
                sql = (any(matches(full, prefix) for prefix in ["sqlalchemy", *orm_modules]) and method in SQL_CALLS) or (any(part in database_aliases for part in receiver_parts) and method in SQL_CALLS)
                if sql and slot not in {"operate", "query", "projection"}:
                    report("sql-slot", file, node, f"Database operation {name} outside operate/query/projection")
                write = method in WRITE_CALLS
                if method in {"execute", "executemany"} and node.args:
                    statement = node.args[0]
                    if isinstance(statement, ast.Call) and dotted(statement.func).rpartition(".")[2] == "text" and statement.args:
                        statement = statement.args[0]
                    if isinstance(statement, ast.Constant) and isinstance(statement.value, str):
                        words = statement.value.split()
                        write = bool(words) and words[0].upper() in {"INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "ALTER", "DROP", "TRUNCATE"}
                if slot in {"query", "projection"} and sql and write:
                    report("readonly-write", file, node, f"Write operation {name} in read-only slot")
            if slot == "facade" and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node in tree.body and not node.name.startswith("_"):
                if node.returns is None:
                    report("facade-return", file, node, f"Exported function {node.name} needs a return annotation")
                else:
                    annotation = node.returns
                    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
                        try:
                            annotation = ast.parse(annotation.value, mode="eval")
                        except SyntaxError:
                            raise ValueError(f"invalid forward return annotation: {file}:{node.lineno}")
                    if any(any(matches(resolve(dotted(part)), prefix) for prefix in orm_modules) for part in ast.walk(annotation) if dotted(part)):
                        report("facade-orm-return", file, node, f"Exported function {node.name} annotates a configured ORM type")
    # Strongly connected components identify cycles without reporting harmless dependencies.
    indices: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    def visit(module: str) -> None:
        indices[module] = low[module] = len(indices)
        stack.append(module)
        on_stack.add(module)
        for target in sorted(edges[module]):
            if target not in indices:
                visit(target)
                low[module] = min(low[module], low[target])
            elif target in on_stack:
                low[module] = min(low[module], indices[target])
        if low[module] == indices[module]:
            component = []
            while True:
                item = stack.pop()
                on_stack.remove(item)
                component.append(item)
                if item == module:
                    break
            if len(component) > 1:
                for item in sorted(component):
                    report("import-cycle", file_by_module[item], trees[file_by_module[item]], f"Import cycle: {', '.join(sorted(component))}")
    for module in sorted(edges):
        if module not in indices:
            visit(module)
    findings = sorted({(f["rule"], f["path"], f["line"], f["message"]) for f in findings}, key=lambda row: (row[1], row[2], row[0], row[3]))
    print(json.dumps({"ok": not findings, "filesScanned": len(files), "engine": "python", "rulesVersion": 1, "findings": [dict(zip(("rule", "path", "line", "message"), row)) for row in findings]}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, SyntaxError, UnicodeError, RecursionError) as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
