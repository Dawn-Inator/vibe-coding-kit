# Portable backend guardrails

The architecture contract has three layers: language-independent ownership rules, language-specific
source analysis, and project/framework-specific behavior tests. A green source check proves only the
rules and source scope it actually inspects. It does not prove that a service is correctly designed.

## Shared rules, native language boundaries

- A domain owns its authoritative state and invariants. Other domains use its explicit API.
- Dependencies must not form cycles. An interface named `facade` does not excuse a cycle.
- Orchestration does not directly construct database operations. Query/projection paths do not write;
  assemblers do not perform database access.
- Boundary outputs have explicit types and do not expose configured ORM types.
- Configured vendor SDK dependencies belong in provider implementations.

The six slots describe responsibilities; they are not six mandatory files for every object. Start with
the files the capability actually needs. Split as responsibilities grow. Python and TypeScript use
facade/model/contracts modules as explicit cross-domain entry points. Go uses package boundaries and
exported symbols; it cannot import a particular `facade.go` file. A compiler check remains necessary.

## Run the shipped analyzers

Copy the matching `templates/backend-architecture.<language>.json` to the adopting project's
`.vibe-coding/backend-architecture.json`, and replace the example paths and import namespaces.
Supported `language` values are `python`, `typescript`, and `go`; omission selects Python for
compatibility. Each configuration selects one language. A polyglot project runs the command once per
language using separate `--config` paths and requires every invocation to succeed.

```sh
node .vibe-coding/kit/cli.mjs backend-check --project-root .
node .vibe-coding/kit/cli.mjs backend-check --project-root . --config .vibe-coding/backend-go.json
```

No framework, database, application imports or network access are needed for source analysis. Python
requires Python 3; Go requires its toolchain to compile the standard-library analyzer; TypeScript
requires the `typescript` compiler API package available in the consumer or kit. Consumers of the
Git submodule should use their existing TypeScript dependency or install a compatible compiler API
package in their project. Missing tools, invalid syntax/configuration, unsupported languages, and
missing or empty source roots fail the check. Installation does not silently select a backend or
enable a lifecycle gate for a frontend-only project.

Configuration fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `language` | Analyzer selection |
| `services` | Nonempty list of source `root` paths and their import `module` namespaces |
| `scanRoots` | Optional additional source roots for provider import checking outside domains |
| `ormModules` | Import prefixes identifying ORM types at public boundaries |
| `providerModules` | Vendor import prefixes restricted to provider implementations |
| `providerRoots` | Project-relative directories allowed to import those vendor modules |

The public shape is [backend-architecture.schema.json](../../schemas/backend-architecture.schema.json).
Paths must exist within the consumer project. The analyzers also validate semantic constraints such as
overlapping service roots and language-specific module names. TypeScript compiler API validation is
tested against 5.9.3; a package without that API fails clearly instead of passing an empty scan.

Domains are the immediate subdirectories of a configured service root. Configure every source area
you intend to protect; files outside those roots are not certified. Files under the roots are not
silently excluded by test naming. Current rules block every finding and have no debt allowlist.
Existing projects with historical debt should retain their established ratchets while adopting this
checker in a clean bounded scope; do not expand scope by blindly accepting a new baseline.

The JSON report includes the analyzer identity, scanned file count, and findings with `rule`, `path`,
`line`, and `message`. Rule implementations use each language's syntax tree. Database recognition is
conservative and tied to known call shapes; wrapper methods, dynamic imports and arbitrary custom ORM
APIs can hide effects. Return annotations are structural evidence, not proof that an arbitrary user
type is a pure DTO. Read the analyzer's fixtures before choosing its supported scope.

## Make the check carry weight

Add a project-owned package script or CI step that executes `backend-check`. The command exits nonzero
on findings or analyzer errors. Projects that want it at managed-worktree candidate verification can
add it to the existing project adapter (preserve any existing hook):

```js
import { checkBackendArchitecture } from '../../../.vibe-coding/kit/src/backend/dispatch.mjs';

export const adapterContract = {
  schemaVersion: 1,
  hooks: { verifyCandidate: 'verifyCandidate' },
};

export async function verifyCandidate({ projectRoot }) {
  return checkBackendArchitecture({ projectRoot });
}
```

The lifecycle runner rejects `{ ok: false }` and exceptions before push. Gate placement remains the
project's policy; this example does not change an existing lightweight development integration policy.
For every enabled language, include a clean fixture and deliberate violations proving that the real
CLI fails. A command listed in a README is not evidence that the project executes it.

## What stays in project adapters

Framework-specific transaction ownership, router registration/authentication, OpenAPI generation and
freshness, event allowlist agreement, migration semantics, storage ownership, and actual query effects
need project-aware checks and contract/integration tests. Reuse their invariants and test patterns,
not a copied LingoFly registry, cloud topology or SQLAlchemy-only assumption. N+1, failure isolation,
latency, deployment independence and business boundary quality need behavior evidence or review.

The kit's analyzers complement these tests; they do not replace them or certify all backend rules.
