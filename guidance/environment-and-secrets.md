# Environment configuration and secrets

This guide is a portable baseline for projects using the kit. It is not a configuration loader, and kit installation or upgrade does not change a project's runtime settings. Adopt it in the project-owned instructions and document any deliberate differences before changing an existing system. Do not silently change precedence in an established project.

## Naming and inventory

- Use `UPPER_SNAKE_CASE` for environment variable names, with a stable project or service prefix where collisions are possible (for example, `ACME_API_PORT`). Avoid generic names such as `TOKEN` and names reserved by the operating system or runtime. Preserve platform-required names and existing public interfaces until a documented migration is complete.
- Name values by purpose and unit, such as `ACME_REQUEST_TIMEOUT_MS`. Do not encode secret values in names. Distinguish public client configuration from server-only values using the framework's actual exposure rules, not just a naming convention.
- Maintain a project-owned inventory for each variable: name, purpose, owner, required or optional, non-secret default if any, type and units, allowed values, environments, source, and whether it is secret or exposed to clients. Include a safe example or placeholder, never an actual credential. Record deprecated names and migration deadlines.
- Validate required values and types at the application boundary; fail with the variable's name and an actionable reason, never its value. Define whether an empty string means missing or is a valid value for each setting. Avoid implicit truthiness for booleans and numbers.

## Configuration precedence

Each project must document one deterministic precedence order for each runtime and entry point, including CI and deployed services. For a new application, a recommended order from highest to lowest is:

1. Explicit per-invocation command-line options, where the application supports them.
2. Values explicitly injected into the process by the deployment platform, secret manager integration, CI, or caller.
3. An explicitly selected, untracked local override file, if the project permits one.
4. A project-owned environment-specific configuration file.
5. Safe application defaults.

The order is a design recommendation, not behavior supplied by the kit. CLI options should not carry secrets: command arguments may be visible in process listings and logs. Never put secrets in application-repository configuration or defaults. A secret-manager reference can be tracked if it contains no secret; the resolved value is injected through the project's approved mechanism. Specify how multiple injection sources interact, whether an override replaces an entire object or an individual key, and whether empty values override lower layers. Select the environment explicitly; reject unknown or ambiguous environments rather than silently falling back to production or another environment. Load and validate configuration once at startup unless the project explicitly defines a reload contract.

Example: if the environment file sets a timeout to 5000 ms and the process environment sets it to 3000 ms, the effective value is 3000 ms under this order. A missing required credential must fail validation; a placeholder is not a usable default.

The kit also offers an optional [JSON environment renderer](../README.md#environment-configuration): its environment overlay takes precedence over the shared base, recursively merging objects and replacing arrays, scalars, and null. It does not load process environment variables or implement the runtime precedence above.

## Choose one secret authority

During a fresh kit install, choose one of two project-owned approaches. The selection is recorded in `.vibe-coding/project.config.json`; it is metadata, not a secret or a working runtime integration. Existing installations keep their current setup until deliberately migrated.

1. **Private GitHub repository (quick setup).** The installer creates a private `<project>-secret-key` repository under the main GitHub project's owner and clones it beside the project. It requires the GitHub CLI, authentication, and permission to create a private repository. If the main project has no GitHub origin, the authenticated account and project directory name are used. The repository may contain plaintext secrets so authorized collaborators can view them directly in GitHub; do not assume private means encrypted end to end. Grant repository access separately and review it as people join or leave. Keep the secret repository outside the application repository. Git history and collaborators' clones retain old values; removing a file is not revocation.
2. **Vault (more setup).** Choose a project-managed Vault server and define provisioning, authentication, policies, runtime delivery, backup and recovery for each environment. Installation records the selection as `not-provisioned`; it does not create a server, install Vault, set policies or migrate credentials. Until the project completes setup, Vault is not ready for use.

Do not silently mix authorities. Document how a secret moves to local development, CI and deployed services, who can read it, and how to recover access on a replacement machine. A private repository is convenient but GitHub repository access generally grants access to its history; Vault can provide finer-grained access and auditing but requires operation and recovery discipline. Follow the project's authorization for credential rotation, revocation and infrastructure changes.

Real secrets belong only in the chosen authority and necessary approved runtime copies. Never put them in the application repository, example files, client bundles, URLs, command arguments, logs, test snapshots, chat transcripts or CI artifacts. Do not print complete environments or configuration objects. Redact values and connection strings in diagnostics. For an exposed credential, follow the project's incident procedure; deleting its current file or rewriting history alone does not make it secret again.

## Adoption and verification

1. Inventory existing sources and consumers, including framework-specific client exposure, generated files and deployed injection. Preserve current behavior while identifying conflicts.
2. Choose and document the project's effective precedence and approved secret source. Introduce any change with an explicit migration and rollback plan; update consumers together.
3. Provide sanitized examples and startup validation. Test precedence with conflicting values, missing and empty required values, invalid types, and client/server exposure boundaries using fake credentials. Check that error paths do not reveal values.
4. Link the project-owned instructions to this guide and its own inventory. Adoption is deliberate: upgrading the kit does not rewrite existing project configuration or automatically enforce this guidance.
