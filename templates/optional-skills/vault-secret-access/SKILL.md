---
name: vault-secret-access
description: Use when a task needs a provider credential, API key, signing file, connection secret, or project runtime secret and this project selected Vault.
---

# Vault secret access

Read `.vibe-coding/project.config.json` `secrets` metadata and the project's Vault access and secret-inventory documentation first. The installer records `not-provisioned`; that is not a working Vault server, credentials, endpoint or permission. If the project has not configured an approved access path, report the missing setup and the operation it blocks. Do not guess a server address, mount, secret path or environment, or fall back to a different store.

When Vault is configured, use the project's existing authenticated access and managed commands to retrieve only the required secret for the intended environment. Prefer injection into the intended child process or the project's approved restricted temporary-file mechanism; keep values out of application source, arguments, URLs, logs, chat, tests and artifacts. Report missing authorization or secret names without exposing values. A read does not grant permission to create or change Vault infrastructure, policies, credentials, or stored secrets; follow the project's authorization and mutation rules.
