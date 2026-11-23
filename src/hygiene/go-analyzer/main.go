// Syntax-only Go hygiene analyzer. It reports defensive-programming and coupling smells
// described by the coding-discipline skill. Input arrives as JSON on stdin; findings go
// to stdout. The analyzer only reports: ratcheting and exemptions live in check.mjs.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type request struct {
	Root              string   `json:"root"`
	Files             []string `json:"files"`
	WideConditionMax  int      `json:"wideConditionMax"`
	CompositionRoots  []string `json:"compositionRoots"`
	DataAccessImports []string `json:"dataAccessImports"`
}

type finding struct {
	Rule    string `json:"rule"`
	Path    string `json:"path"`
	Symbol  string `json:"symbol"`
	Line    int    `json:"line"`
	Message string `json:"message"`
}

type response struct {
	FilesScanned int       `json:"filesScanned"`
	Generated    []string  `json:"generated"`
	Findings     []finding `json:"findings"`
}

var generatedHeader = regexp.MustCompile(`(?m)^// Code generated .* DO NOT EDIT\.$`)

func main() {
	var req request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		fmt.Fprintln(os.Stderr, "decode request:", err)
		os.Exit(1)
	}
	res, err := analyze(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(res); err != nil {
		fmt.Fprintln(os.Stderr, "encode response:", err)
		os.Exit(1)
	}
}

func analyze(req request) (response, error) {
	res := response{Generated: []string{}, Findings: []finding{}}
	for _, rel := range req.Files {
		src, err := os.ReadFile(filepath.Join(req.Root, filepath.FromSlash(rel)))
		if err != nil {
			return res, err
		}
		if generatedHeader.Match(src) {
			res.Generated = append(res.Generated, rel)
			continue
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, rel, src, parser.SkipObjectResolution)
		if err != nil {
			return res, fmt.Errorf("parse %s: %w", rel, err)
		}
		res.FilesScanned++
		a := fileAnalyzer{req: req, rel: rel, fset: fset, file: file}
		res.Findings = append(res.Findings, a.run()...)
	}
	return res, nil
}

type fileAnalyzer struct {
	req      request
	rel      string
	fset     *token.FileSet
	file     *ast.File
	findings []finding
}

func (a *fileAnalyzer) report(rule, symbol string, at token.Pos, message string) {
	a.findings = append(a.findings, finding{Rule: rule, Path: a.rel, Symbol: symbol, Line: a.fset.Position(at).Line, Message: message})
}

func (a *fileAnalyzer) run() []finding {
	imports := importNames(a.file)
	a.checkCompositionRoot()
	for _, decl := range a.file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		a.checkFunc(fn, imports)
	}
	return a.findings
}

// importNames maps import path to the local name used in this file.
func importNames(file *ast.File) map[string]string {
	names := map[string]string{}
	for _, spec := range file.Imports {
		p, _ := strconv.Unquote(spec.Path.Value)
		name := path.Base(p)
		if spec.Name != nil {
			name = spec.Name.Name
		}
		names[p] = name
	}
	return names
}

func (a *fileAnalyzer) checkCompositionRoot() {
	if !matchAny(a.req.CompositionRoots, a.rel) {
		return
	}
	for _, spec := range a.file.Imports {
		p, _ := strconv.Unquote(spec.Path.Value)
		if matchAnyPrefix(a.req.DataAccessImports, p) {
			a.report("composition-root-data-access", p, spec.Pos(), "composition root imports a data-access package; move the logic into a service or adapter and only wire it here")
		}
	}
}

func (a *fileAnalyzer) checkFunc(fn *ast.FuncDecl, imports map[string]string) {
	symbol := funcSymbol(fn)
	receiver := ""
	if fn.Recv != nil && len(fn.Recv.List) == 1 && len(fn.Recv.List[0].Names) == 1 {
		receiver = fn.Recv.List[0].Names[0].Name
	}
	contexts := contextParams(fn, imports["context"])
	_, usesReflect := imports["reflect"]

	ast.Inspect(fn.Body, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.FuncLit:
			for name := range contextParamsOf(n.Type, imports["context"]) {
				contexts[name] = true
			}
		case *ast.BinaryExpr:
			if name, ok := nilComparison(n); ok {
				switch {
				case contexts[name]:
					a.report("nil-context-check", symbol, n.Pos(), "context.Context is never nil by convention; drop the check")
				case receiver != "" && name == receiver:
					a.report("nil-receiver-guard", symbol, n.Pos(), "receiver nil guard; guarantee a valid value at construction instead")
				}
			}
		case *ast.IfStmt:
			if count := operandCount(n.Cond); count > a.req.WideConditionMax {
				a.report("wide-condition", symbol, n.Pos(), fmt.Sprintf("condition joins %d operands (max %d); name the predicate or move invariants to construction", count, a.req.WideConditionMax))
			}
			if errName, ok := checkedError(n.Cond); ok && collapsesError(n.Body, errName) {
				a.report("collapsed-error", symbol, n.Pos(), "error is replaced by a sentinel without wrapping; keep the cause with fmt.Errorf(\"...: %w\", err)")
			}
		case *ast.CallExpr:
			switch callName(n) {
			case "recover":
				a.report("scattered-recover", symbol, n.Pos(), "recover belongs in one interceptor or middleware, not in each handler")
			case "IsNil":
				if usesReflect {
					a.report("reflect-nil-probe", symbol, n.Pos(), "reflection-based nil probing hides wiring bugs; validate dependencies once at construction")
				}
			case "GetUnknown":
				if len(n.Args) == 0 {
					a.report("unknown-field-rejection", symbol, n.Pos(), "inspecting unknown protobuf fields usually means rejecting them; tolerate unknown fields on internal calls")
				}
			}
		}
		return true
	})
}

func funcSymbol(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 {
		return fn.Name.Name
	}
	return receiverType(fn.Recv.List[0].Type) + "." + fn.Name.Name
}

func receiverType(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.StarExpr:
		return receiverType(t.X)
	case *ast.IndexExpr:
		return receiverType(t.X)
	case *ast.IndexListExpr:
		return receiverType(t.X)
	case *ast.Ident:
		return t.Name
	}
	return "?"
}

func contextParams(fn *ast.FuncDecl, contextName string) map[string]bool {
	return contextParamsOf(fn.Type, contextName)
}

// contextParamsOf returns parameters typed context.Context. A parameter named ctx counts
// even when its type is spelled through an alias, because that is the Go convention.
func contextParamsOf(ft *ast.FuncType, contextName string) map[string]bool {
	names := map[string]bool{}
	if ft.Params == nil {
		return names
	}
	for _, field := range ft.Params.List {
		isContext := false
		if sel, ok := field.Type.(*ast.SelectorExpr); ok && contextName != "" {
			if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == contextName && sel.Sel.Name == "Context" {
				isContext = true
			}
		}
		for _, name := range field.Names {
			if isContext || name.Name == "ctx" {
				names[name.Name] = true
			}
		}
	}
	return names
}

// nilComparison returns the identifier compared against nil with == or !=.
func nilComparison(b *ast.BinaryExpr) (string, bool) {
	if b.Op != token.EQL && b.Op != token.NEQ {
		return "", false
	}
	if isNil(b.Y) {
		if id, ok := b.X.(*ast.Ident); ok {
			return id.Name, true
		}
	}
	if isNil(b.X) {
		if id, ok := b.Y.(*ast.Ident); ok {
			return id.Name, true
		}
	}
	return "", false
}

func isNil(e ast.Expr) bool {
	id, ok := e.(*ast.Ident)
	return ok && id.Name == "nil"
}

// operandCount counts leaves of a chain of && and || operators.
func operandCount(e ast.Expr) int {
	switch t := e.(type) {
	case *ast.ParenExpr:
		return operandCount(t.X)
	case *ast.BinaryExpr:
		if t.Op == token.LAND || t.Op == token.LOR {
			return operandCount(t.X) + operandCount(t.Y)
		}
	}
	return 1
}

// checkedError finds `<err> != nil` inside a condition, where <err> looks like an error variable.
func checkedError(cond ast.Expr) (string, bool) {
	var name string
	ast.Inspect(cond, func(n ast.Node) bool {
		b, ok := n.(*ast.BinaryExpr)
		if !ok || b.Op != token.NEQ || name != "" {
			return name == ""
		}
		if id, ok := nilComparison(b); ok && isErrorName(id) {
			name = id
		}
		return name == ""
	})
	return name, name != ""
}

func isErrorName(name string) bool {
	return name == "err" || name == "e" || strings.HasSuffix(name, "Err")
}

// collapsesError reports a return directly in the block whose final result is a bare
// identifier or selector (a sentinel) that does not mention the checked error.
func collapsesError(body *ast.BlockStmt, errName string) bool {
	for _, stmt := range body.List {
		ret, ok := stmt.(*ast.ReturnStmt)
		if !ok || len(ret.Results) == 0 {
			continue
		}
		last := ret.Results[len(ret.Results)-1]
		if isSentinel(last) && !mentions(last, errName) {
			return true
		}
	}
	return false
}

func isSentinel(e ast.Expr) bool {
	switch t := e.(type) {
	case *ast.Ident:
		return t.Name != "nil" && t.Name != "true" && t.Name != "false" && strings.HasPrefix(t.Name, "Err")
	case *ast.SelectorExpr:
		return strings.HasPrefix(t.Sel.Name, "Err")
	}
	return false
}

func mentions(e ast.Expr, name string) bool {
	found := false
	ast.Inspect(e, func(n ast.Node) bool {
		if id, ok := n.(*ast.Ident); ok && id.Name == name {
			found = true
		}
		return !found
	})
	return found
}

func callName(c *ast.CallExpr) string {
	switch f := c.Fun.(type) {
	case *ast.Ident:
		return f.Name
	case *ast.SelectorExpr:
		return f.Sel.Name
	}
	return ""
}

// matchAny matches slash paths against patterns where `*` is one segment and `**` any depth.
func matchAny(patterns []string, rel string) bool {
	for _, p := range patterns {
		if globMatch(strings.Split(p, "/"), strings.Split(rel, "/")) {
			return true
		}
	}
	return false
}

// matchAnyPrefix matches an import path against patterns, treating each pattern as a prefix.
func matchAnyPrefix(patterns []string, importPath string) bool {
	for _, p := range patterns {
		if globMatch(append(strings.Split(p, "/"), "**"), strings.Split(importPath, "/")) {
			return true
		}
	}
	return false
}

func globMatch(pattern, parts []string) bool {
	if len(pattern) == 0 {
		return len(parts) == 0
	}
	if pattern[0] == "**" {
		for i := 0; i <= len(parts); i++ {
			if globMatch(pattern[1:], parts[i:]) {
				return true
			}
		}
		return false
	}
	if len(parts) == 0 {
		return false
	}
	ok, _ := path.Match(pattern[0], parts[0])
	return ok && globMatch(pattern[1:], parts[1:])
}
