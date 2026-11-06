---
name: secret-repository-access
description: Use when a task needs a provider credential, API key, signing file, connection secret, or project runtime secret and this project selected a private GitHub secret repository.
---

# Secret repository access

When a task requires a credential, first read the project's `.vibe-coding/project.config.json` `secrets` metadata and its secret inventory or setup instructions. `secrets.repository` names the private GitHub repository and `secrets.localPath` locates its sibling checkout relative to the project root. Treat these as locations, not secret values. Follow the project's environment, identity, access and authorization rules.

Use the existing private clone and documented file/key mapping to locate the needed value; inspect only the relevant file and field, and use the selected environment. The secret repository may contain plaintext so authorized users can view it in GitHub. If the clone is absent, verify the configured GitHub repository is private and that the current identity has access before cloning to the configured path. Never create or adopt a replacement repository when access fails. If a credential or mapping is absent, report its name and the blocked operation rather than guessing or using another environment.

Pass values only to the authorized operation through the project's approved process environment or restricted temporary file path. Do not put values in the application repository, command arguments, logs, chat, tests, fixtures or artifacts. Do not print complete secret files. Update, rotate or delete credentials only when authorized and through the project's documented workflow; a read does not authorize changes. The secret repository is the chosen authority, while runtime copies must follow project policy.
