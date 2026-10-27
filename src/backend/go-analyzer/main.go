// A syntax-only Go architecture checker. It scans every Go file regardless of build tags.
// Cross-domain imports use Go's package-level exported API, not Python facade import rules.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type service struct {
	Root   string `json:"root"`
	Module string `json:"module"`
}
type config struct {
	SchemaVersion   int       `json:"schemaVersion"`
	Language        string    `json:"language"`
	Services        []service `json:"services"`
	ScanRoots       []string  `json:"scanRoots"`
	ProviderModules []string  `json:"providerModules"`
	ProviderRoots   []string  `json:"providerRoots"`
	ORMModules      []string  `json:"ormModules"`
}
type finding struct {
	Rule    string `json:"rule"`
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Message string `json:"message"`
}
type result struct {
	OK           bool      `json:"ok"`
	Engine       string    `json:"engine"`
	RulesVersion int       `json:"rulesVersion"`
	FilesScanned int       `json:"filesScanned"`
	Findings     []finding `json:"findings"`
}
type parsed struct {
	file                *ast.File
	fs                  *token.FileSet
	name, rel, dir, pkg string
	imports             map[string]string
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
func within(root, candidate string) bool {
	r, e := filepath.Rel(root, candidate)
	return e == nil && r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) && !filepath.IsAbs(r)
}
func safe(root, rel string, dir bool) (string, error) {
	if rel == "" || filepath.IsAbs(rel) || filepath.Clean(rel) == ".." || strings.HasPrefix(filepath.Clean(rel), ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid relative path %q", rel)
	}
	p := filepath.Join(root, rel)
	resolved, e := filepath.EvalSymlinks(p)
	if e != nil {
		return "", e
	}
	if !within(root, resolved) {
		return "", fmt.Errorf("path escapes project: %s", rel)
	}
	info, e := os.Stat(resolved)
	if e != nil {
		return "", e
	}
	if dir && !info.IsDir() {
		return "", fmt.Errorf("not a directory: %s", rel)
	}
	return resolved, nil
}
func matches(s string, values []string) bool {
	for _, v := range values {
		if s == v || strings.HasPrefix(s, v+"/") {
			return true
		}
	}
	return false
}
func main() {
	if len(os.Args) != 3 {
		fail(fmt.Errorf("expected project root and config"))
	}
	if e := run(os.Args[1], os.Args[2]); e != nil {
		fail(e)
	}
}
func run(root, configPath string) error {
	root, e := filepath.EvalSymlinks(root)
	if e != nil {
		return e
	}
	root, e = filepath.Abs(root)
	if e != nil {
		return e
	}
	configPath, e = filepath.EvalSymlinks(configPath)
	if e != nil {
		return e
	}
	configPath, e = filepath.Abs(configPath)
	if e != nil {
		return e
	}
	rel, e := filepath.Rel(root, configPath)
	if e != nil {
		return e
	}
	cp, e := safe(root, rel, false)
	if e != nil {
		return e
	}
	input, e := os.Open(cp)
	if e != nil {
		return e
	}
	defer input.Close()
	var c config
	dec := json.NewDecoder(input)
	dec.DisallowUnknownFields()
	if e = dec.Decode(&c); e != nil {
		return e
	}
	var extra any
	if e = dec.Decode(&extra); e != io.EOF {
		return fmt.Errorf("invalid trailing config data")
	}
	if c.SchemaVersion != 1 || c.Language != "go" || len(c.Services) == 0 {
		return fmt.Errorf("invalid Go architecture config: schemaVersion, language and services required")
	}
	for _, arr := range [][]string{c.ProviderModules, c.ORMModules} {
		for _, v := range arr {
			if v == "" || strings.TrimSpace(v) != v {
				return fmt.Errorf("invalid module %q", v)
			}
		}
	}
	roots := []string{}
	modules := map[string]bool{}
	for _, s := range c.Services {
		if s.Module == "" || strings.TrimSpace(s.Module) != s.Module || modules[s.Module] {
			return fmt.Errorf("invalid or duplicate service module %q", s.Module)
		}
		modules[s.Module] = true
		p, err := safe(root, s.Root, true)
		if err != nil {
			return err
		}
		roots = append(roots, p)
	}
	providerRoots := []string{}
	for _, r := range c.ProviderRoots {
		p, err := safe(root, r, true)
		if err != nil {
			return err
		}
		providerRoots = append(providerRoots, p)
	}
	scanRoots := append([]string{}, roots...)
	scanRoots = append(scanRoots, providerRoots...)
	for _, r := range c.ScanRoots {
		p, err := safe(root, r, true)
		if err != nil {
			return err
		}
		scanRoots = append(scanRoots, p)
	}
	scanCounts := make([]int, len(scanRoots))
	out := result{OK: true, Engine: "go", RulesVersion: 1, Findings: []finding{}}
	files := []parsed{}
	scopes := make([]int, len(roots))
	e = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		selected := false
		for _, r := range scanRoots {
			if within(r, p) {
				selected = true
			}
		}
		if d.Type()&os.ModeSymlink != 0 {
			if selected {
				return fmt.Errorf("symlink in scan: %s", p)
			}
			return nil
		}
		if d.IsDir() {
			if p != root && (d.Name() == ".git" || d.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if !selected || !strings.HasSuffix(d.Name(), ".go") {
			return nil
		}
		for i, r := range scanRoots {
			if within(r, p) {
				scanCounts[i]++
			}
		}
		fs := token.NewFileSet()
		f, err := parser.ParseFile(fs, p, nil, parser.AllErrors)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		dir := filepath.Dir(p)
		pkg := ""
		for i, r := range roots {
			if within(r, dir) {
				sub, _ := filepath.Rel(r, dir)
				scopes[i]++
				pkg = path.Join(c.Services[i].Module, filepath.ToSlash(sub))
			}
		}
		imports := map[string]string{}
		for _, im := range f.Imports {
			v, err := strconv.Unquote(im.Path.Value)
			if err != nil {
				return err
			}
			alias := path.Base(v)
			if im.Name != nil {
				alias = im.Name.Name
			}
			imports[alias] = v
		}
		files = append(files, parsed{f, fs, p, filepath.ToSlash(rel), dir, pkg, imports})
		return nil
	})
	if e != nil {
		return e
	}
	for i, n := range scopes {
		if n == 0 {
			return fmt.Errorf("empty service scope: %s", c.Services[i].Root)
		}
	}
	for i, n := range scanCounts {
		if n == 0 {
			return fmt.Errorf("empty scan scope: %s", scanRoots[i])
		}
	}
	out.FilesScanned = len(files)
	add := func(p parsed, pos token.Pos, rule, msg string) {
		out.Findings = append(out.Findings, finding{rule, p.rel, p.fs.Position(pos).Line, msg})
	}
	graph := map[string]map[string]bool{}
	for _, p := range files {
		if p.pkg != "" {
			if graph[p.pkg] == nil {
				graph[p.pkg] = map[string]bool{}
			}
			for _, v := range p.imports {
				graph[p.pkg][v] = true
			}
		}
	}
	var reaches func(string, string, map[string]bool) bool
	reaches = func(from, target string, seen map[string]bool) bool {
		if from == target {
			return true
		}
		if seen[from] {
			return false
		}
		seen[from] = true
		for next := range graph[from] {
			if reaches(next, target, seen) {
				return true
			}
		}
		return false
	}
	for _, p := range files {
		for _, im := range p.file.Imports {
			v, _ := strconv.Unquote(im.Path.Value)
			allowed := false
			for _, r := range providerRoots {
				if within(r, p.dir) {
					allowed = true
				}
			}
			if matches(v, c.ProviderModules) && !allowed {
				add(p, im.Pos(), "provider-import", "provider module must be imported within a provider root")
			}
			if p.pkg != "" && graph[v] != nil && reaches(v, p.pkg, map[string]bool{}) {
				add(p, im.Pos(), "import-cycle", "package import participates in a cycle")
			}
		}
		if p.pkg == "" {
			continue
		}
		slot := strings.TrimSuffix(filepath.Base(p.name), ".go")
		allowedDB := slot == "operate" || slot == "query" || slot == "projection"
		readonly := slot == "query" || slot == "projection"
		{
			for _, decl := range p.file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || !fn.Name.IsExported() {
					continue
				}
				if fn.Type.Results == nil || len(fn.Type.Results.List) == 0 {
					continue
				}
				ast.Inspect(fn.Type.Results, func(n ast.Node) bool {
					sel, ok := n.(*ast.SelectorExpr)
					if ok {
						id, ok := sel.X.(*ast.Ident)
						if ok && matches(p.imports[id.Name], c.ORMModules) {
							add(p, sel.Pos(), "facade-orm-return", "exported function result exposes an ORM type")
						}
					}
					return true
				})
			}
		}
		ast.Inspect(p.file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			method := strings.ToLower(sel.Sel.Name)
			receiver := receiverName(sel.X)
			dbReceiver := isDBReceiver(receiver)
			orm := matches(p.imports[receiver], c.ORMModules)
			isDB := dbReceiver && dbMethod(method) || orm && ormMethod(method)
			if !isDB {
				return true
			}
			if !allowedDB {
				add(p, call.Pos(), "sql-slot", "database calls belong in operate.go, query.go or projection.go")
			}
			if readonly && (writeMethod(method) || sqlWrite(call)) {
				add(p, call.Pos(), "readonly-write", "query and projection must not write")
			}
			return true
		})
	}
	sort.Slice(out.Findings, func(i, j int) bool {
		a, b := out.Findings[i], out.Findings[j]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Rule < b.Rule
	})
	out.OK = len(out.Findings) == 0
	return json.NewEncoder(os.Stdout).Encode(out)
}
func receiverName(x ast.Expr) string {
	switch v := x.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.SelectorExpr:
		if isDBReceiver(v.Sel.Name) {
			return v.Sel.Name
		}
		return receiverName(v.X)
	case *ast.CallExpr:
		if s, ok := v.Fun.(*ast.SelectorExpr); ok {
			return receiverName(s.X)
		}
	case *ast.ParenExpr:
		return receiverName(v.X)
	}
	return ""
}
func isDBReceiver(s string) bool {
	s = strings.ToLower(s)
	return s == "db" || s == "tx" || s == "session" || s == "conn" || s == "connection" || strings.HasSuffix(s, "db") || strings.HasSuffix(s, "session") || strings.HasSuffix(s, "conn") || strings.HasSuffix(s, "connection")
}
func dbMethod(s string) bool {
	switch s {
	case "query", "querycontext", "queryrow", "queryrowcontext", "exec", "execcontext", "prepare", "preparecontext", "begin", "begintx", "commit", "rollback", "select", "get", "insert", "update", "delete", "save", "create", "first", "find", "scan", "raw", "where", "model", "table":
		return true
	}
	return false
}
func ormMethod(s string) bool {
	switch s {
	case "select", "insert", "update", "delete", "create", "save", "exec", "query", "raw", "model", "table":
		return true
	}
	return false
}
func writeMethod(s string) bool {
	switch s {
	case "exec", "execcontext", "insert", "update", "delete", "save", "create", "commit", "begin", "begintx":
		return true
	}
	return false
}
func sqlWrite(c *ast.CallExpr) bool {
	for _, a := range c.Args {
		if lit, ok := a.(*ast.BasicLit); ok && lit.Kind == token.STRING {
			v, e := strconv.Unquote(lit.Value)
			if e == nil {
				fields := strings.Fields(strings.ToLower(v))
				if len(fields) > 0 {
					switch fields[0] {
					case "insert", "update", "delete", "replace", "alter", "drop", "create", "truncate", "merge":
						return true
					}
				}
			}
		}
	}
	return false
}
